import argparse
import datetime
import json
import os
import struct
import time


SUPPORTED_EXTENSIONS = (".flac", ".m4a")
INDEX_VERSION = 2


def parse_arguments():
    parser = argparse.ArgumentParser(
        description=(
            "Create library.json for MusiCards from a "
            "Picard-tagged FLAC/M4A music folder."
        )
    )
    parser.add_argument(
        "music_folder",
        nargs="?",
        help="Path to the root Music folder (you can drag the folder into the terminal).",
    )
    parser.add_argument(
        "--output",
        help="Optional output path. Defaults to library.json in the Music folder.",
    )
    return parser.parse_args()


def resolve_paths(arguments):
    music_folder = arguments.music_folder
    if not music_folder:
        music_folder = input("Music folder path: ").strip().strip('"').strip("'")
    if not music_folder:
        raise SystemExit("Error: no Music folder was provided.")

    music_dir = os.path.abspath(os.path.expanduser(music_folder))
    if not os.path.isdir(music_dir):
        raise SystemExit(f"Error: Music folder does not exist: {music_dir}")

    output_path = arguments.output or os.path.join(music_dir, "library.json")
    output_path = os.path.abspath(os.path.expanduser(output_path))
    return music_dir, output_path


def empty_metadata(file_path):
    return {
        "filename": os.path.basename(file_path),
        "title": None,
        "track_mbid": None,
        "release_track_mbid": None,
        "album_mbid": None,
        "album_name": None,
        "artist_name": None,
        "release_year": None,
        "country": None,
        "label": None,
        "media_format": None,
    }


def first(tags, *names):
    for name in names:
        values = tags.get(name.lower())
        if values:
            return values[0]
    return None


def metadata_from_tags(file_path, tags):
    metadata = empty_metadata(file_path)
    date = first(tags, "date", "©day")
    metadata.update({
        "title": first(tags, "title", "©nam"),
        "track_mbid": first(tags, "musicbrainz_trackid", "musicbrainz track id"),
        "release_track_mbid": first(
            tags,
            "musicbrainz_releasetrackid",
            "musicbrainz release track id",
        ),
        "album_mbid": first(tags, "musicbrainz_albumid", "musicbrainz album id"),
        "album_name": first(tags, "album", "©alb"),
        "artist_name": first(tags, "albumartist", "aart", "artist", "©art"),
        "release_year": date[:4] if date else None,
        "country": first(
            tags,
            "releasecountry",
            "musicbrainz album release country",
        ),
        "label": first(tags, "label", "organization"),
        "media_format": first(tags, "media"),
    })
    if not metadata["title"]:
        metadata["title"] = os.path.splitext(metadata["filename"])[0]
    return metadata


def empty_technical_metadata():
    return {
        "codec": None,
        "bit_depth": None,
        "sample_rate": None,
        "bitrate": None,
        "channels": None,
    }


def read_exact(file_obj, size):
    data = file_obj.read(size)
    if len(data) != size:
        raise ValueError("The file ended unexpectedly")
    return data


def read_flac_tags(file_path):
    """Read only the FLAC Vorbis Comment block and skip the PICTURE block."""
    tags = {}
    technical = empty_technical_metadata()
    technical["codec"] = "FLAC"
    with open(file_path, "rb") as file_obj:
        if read_exact(file_obj, 4) != b"fLaC":
            raise ValueError("Not a valid FLAC file")

        is_last = False
        while not is_last:
            header = read_exact(file_obj, 4)
            is_last = bool(header[0] & 0x80)
            block_type = header[0] & 0x7F
            block_size = int.from_bytes(header[1:4], "big")

            if block_type == 0:  # STREAMINFO
                block = read_exact(file_obj, block_size)
                if len(block) >= 18:
                    packed = int.from_bytes(block[10:18], "big")
                    technical["sample_rate"] = (packed >> 44) & 0xFFFFF
                    technical["channels"] = ((packed >> 41) & 0x07) + 1
                    technical["bit_depth"] = ((packed >> 36) & 0x1F) + 1
                continue

            if block_type != 4:  # 4 = VORBIS_COMMENT; 6 = PICTURE
                file_obj.seek(block_size, os.SEEK_CUR)
                continue

            block_end = file_obj.tell() + block_size
            vendor_size = struct.unpack("<I", read_exact(file_obj, 4))[0]
            file_obj.seek(vendor_size, os.SEEK_CUR)
            comment_count = struct.unpack("<I", read_exact(file_obj, 4))[0]

            for _ in range(comment_count):
                comment_size = struct.unpack("<I", read_exact(file_obj, 4))[0]
                comment = read_exact(file_obj, comment_size).decode("utf-8", "replace")
                if "=" not in comment:
                    continue
                name, value = comment.split("=", 1)
                tags.setdefault(name.lower(), []).append(value)

            file_obj.seek(block_end)

    return tags, technical


def iter_mp4_boxes(file_obj, start, end):
    """Walk through MP4 box headers without loading their contents."""
    position = start
    while position + 8 <= end:
        file_obj.seek(position)
        size32, box_type = struct.unpack(">I4s", read_exact(file_obj, 8))
        header_size = 8
        if size32 == 1:
            box_size = struct.unpack(">Q", read_exact(file_obj, 8))[0]
            header_size = 16
        elif size32 == 0:
            box_size = end - position
        else:
            box_size = size32

        if box_size < header_size or position + box_size > end:
            raise ValueError("Invalid MP4 box structure")

        payload_start = position + header_size
        box_end = position + box_size
        yield box_type, payload_start, box_end
        position = box_end


def find_mp4_ilst(file_obj, start, end, container_type=None):
    child_start = start + 4 if container_type == b"meta" else start
    for box_type, payload_start, box_end in iter_mp4_boxes(file_obj, child_start, end):
        if box_type == b"ilst":
            return payload_start, box_end
        if box_type in (b"moov", b"udta", b"meta"):
            found = find_mp4_ilst(file_obj, payload_start, box_end, box_type)
            if found:
                return found
    return None


def mp4_child_payload(file_obj, start, end, wanted_type):
    for box_type, payload_start, box_end in iter_mp4_boxes(file_obj, start, end):
        if box_type == wanted_type:
            return read_exact(file_obj, box_end - payload_start)
    return None


def mp4_child_box(file_obj, start, end, wanted_type):
    for box_type, payload_start, box_end in iter_mp4_boxes(file_obj, start, end):
        if box_type == wanted_type:
            return payload_start, box_end
    return None


def read_m4a_technical_metadata(file_obj, file_size):
    technical = empty_technical_metadata()
    moov = mp4_child_box(file_obj, 0, file_size, b"moov")
    if not moov:
        return technical

    for box_type, trak_start, trak_end in iter_mp4_boxes(file_obj, *moov):
        if box_type != b"trak":
            continue
        mdia = mp4_child_box(file_obj, trak_start, trak_end, b"mdia")
        if not mdia:
            continue
        hdlr = mp4_child_box(file_obj, *mdia, b"hdlr")
        if not hdlr:
            continue
        file_obj.seek(hdlr[0])
        handler = read_exact(file_obj, min(12, hdlr[1] - hdlr[0]))
        if len(handler) < 12 or handler[8:12] != b"soun":
            continue

        minf = mp4_child_box(file_obj, *mdia, b"minf")
        stbl = mp4_child_box(file_obj, *minf, b"stbl") if minf else None
        stsd = mp4_child_box(file_obj, *stbl, b"stsd") if stbl else None
        if not stsd or stsd[0] + 16 > stsd[1]:
            continue

        # Skip FullBox flags and entry count, then read the first sample entry.
        entries_start = stsd[0] + 8
        entries = iter_mp4_boxes(file_obj, entries_start, stsd[1])
        try:
            codec_type, entry_start, entry_end = next(entries)
        except StopIteration:
            continue

        technical["codec"] = "ALAC" if codec_type == b"alac" else "AAC" if codec_type == b"mp4a" else codec_type.decode("latin-1").upper()
        file_obj.seek(entry_start)
        sample_entry = read_exact(file_obj, min(28, entry_end - entry_start))
        if len(sample_entry) >= 28:
            technical["channels"] = int.from_bytes(sample_entry[16:18], "big") or None
            technical["bit_depth"] = int.from_bytes(sample_entry[18:20], "big") or None
            technical["sample_rate"] = int.from_bytes(sample_entry[24:28], "big") >> 16 or None

        if codec_type == b"alac" and entry_start + 28 < entry_end:
            alac = mp4_child_box(file_obj, entry_start + 28, entry_end, b"alac")
            if alac:
                file_obj.seek(alac[0])
                config = read_exact(file_obj, min(28, alac[1] - alac[0]))
                if len(config) >= 28 and config[8] == 0:
                    technical["bit_depth"] = config[9]
                    technical["channels"] = config[13]
                    technical["bitrate"] = int.from_bytes(config[20:24], "big") or None
                    technical["sample_rate"] = int.from_bytes(config[24:28], "big") or None
        return technical

    return technical


def decode_mp4_data(payload):
    # The first 8 bytes contain the type and locale; the value follows them.
    if not payload or len(payload) < 8:
        return None
    value = payload[8:]
    try:
        return value.decode("utf-8").rstrip("\x00")
    except UnicodeDecodeError:
        return value.decode("utf-16", "replace").rstrip("\x00")


def read_m4a_tags(file_path):
    """Read text atoms from ilst while completely skipping the covr atom."""
    tags = {}
    with open(file_path, "rb") as file_obj:
        file_size = os.fstat(file_obj.fileno()).st_size
        ilst = find_mp4_ilst(file_obj, 0, file_size)
        technical = read_m4a_technical_metadata(file_obj, file_size)
        if not ilst:
            return tags, technical

        text_atoms = {
            b"\xa9nam": "©nam",
            b"\xa9alb": "©alb",
            b"aART": "aart",
            b"\xa9ART": "©art",
            b"\xa9day": "©day",
        }

        for atom_type, payload_start, atom_end in iter_mp4_boxes(file_obj, *ilst):
            if atom_type == b"covr":
                continue

            if atom_type in text_atoms:
                payload = mp4_child_payload(file_obj, payload_start, atom_end, b"data")
                value = decode_mp4_data(payload)
                if value:
                    tags.setdefault(text_atoms[atom_type], []).append(value)
                continue

            if atom_type != b"----":
                continue

            name_payload = mp4_child_payload(file_obj, payload_start, atom_end, b"name")
            data_payload = mp4_child_payload(file_obj, payload_start, atom_end, b"data")
            if not name_payload or len(name_payload) < 4:
                continue
            name = name_payload[4:].decode("utf-8", "replace").rstrip("\x00").lower()
            value = decode_mp4_data(data_payload)
            if value:
                tags.setdefault(name, []).append(value)

    return tags, technical


def read_metadata(file_path):
    extension = os.path.splitext(file_path)[1].lower()
    if extension == ".flac":
        tags, technical = read_flac_tags(file_path)
    elif extension == ".m4a":
        tags, technical = read_m4a_tags(file_path)
    else:
        raise ValueError(f"Unsupported file type: {extension}")
    metadata = metadata_from_tags(file_path, tags)
    metadata.update(technical)
    return metadata


def load_existing_library(output_path):
    if not os.path.isfile(output_path):
        return {}
    try:
        with open(output_path, "r", encoding="utf-8") as input_file:
            library = json.load(input_file)
        if not isinstance(library, list):
            raise ValueError("the top-level JSON value is not an array")
        return {
            album.get("folder_path"): album
            for album in library
            if isinstance(album, dict) and album.get("folder_path")
        }
    except Exception as error:
        print(f"⚠️ Existing index cannot be reused; rebuilding it ({error})")
        return {}


def album_is_unchanged(album, folder_path, audio_files):
    if album.get("index_version") != INDEX_VERSION:
        return False
    tracks = album.get("tracks")
    if not isinstance(tracks, list) or len(tracks) != len(audio_files):
        return False
    tracks_by_name = {
        track.get("filename"): track
        for track in tracks
        if isinstance(track, dict) and track.get("filename")
    }
    if set(tracks_by_name) != set(audio_files):
        return False

    for filename in audio_files:
        track = tracks_by_name[filename]
        if "file_size" not in track or "modified_ns" not in track:
            return False
        file_stat = os.stat(os.path.join(folder_path, filename))
        if (
            track["file_size"] != file_stat.st_size
            or track["modified_ns"] != file_stat.st_mtime_ns
        ):
            return False
    return True


def main():
    arguments = parse_arguments()
    music_dir, output_path = resolve_paths(arguments)
    started_at = time.perf_counter()
    print(f"🎵 Music library indexing started: {music_dir}")
    library = []
    skipped_missing_release_mbid = 0
    existing_library = load_existing_library(output_path)

    for root, dirs, files in os.walk(music_dir):
        dirs.sort()
        audio_files = sorted(
            filename for filename in files
            if filename.lower().endswith(SUPPORTED_EXTENSIONS)
        )
        if not audio_files:
            continue

        # JSON paths always use forward slashes so the web player and native
        # apps can resolve the same index on Windows, macOS and Linux.
        relative_path = os.path.relpath(root, music_dir).replace(os.sep, "/")
        existing_album = existing_library.get(relative_path)
        if existing_album and album_is_unchanged(existing_album, root, audio_files):
            library.append(existing_album)
            print(
                "♻️ Unchanged: "
                f"{existing_album.get('artist_name') or '?'} - "
                f"{existing_album.get('album_name') or os.path.basename(root)} "
                f"({len(audio_files)} tracks)"
            )
            continue

        tracks = []
        album_meta = None

        for audio_file in audio_files:
            file_path = os.path.join(root, audio_file)
            try:
                metadata = read_metadata(file_path)
            except Exception as error:
                print(f"⚠️ Could not read, skipped: {file_path} ({error})")
                continue

            if album_meta is None:
                album_meta = metadata
            elif (
                album_meta["album_mbid"]
                and metadata["album_mbid"]
                and album_meta["album_mbid"] != metadata["album_mbid"]
            ):
                print(
                    "⚠️ Skipped (Release MBID differs from its folder): "
                    f"{file_path}"
                )
                continue

            file_stat = os.stat(file_path)
            tracks.append({
                "filename": metadata["filename"],
                "title": metadata["title"],
                "track_mbid": metadata["track_mbid"],
                "release_track_mbid": metadata["release_track_mbid"],
                "codec": metadata["codec"],
                "bit_depth": metadata["bit_depth"],
                "sample_rate": metadata["sample_rate"],
                "bitrate": metadata["bitrate"],
                "channels": metadata["channels"],
                "file_size": file_stat.st_size,
                "modified_ns": file_stat.st_mtime_ns,
                "modified_at": datetime.datetime.fromtimestamp(
                    file_stat.st_mtime,
                    tz=datetime.timezone.utc,
                ).isoformat().replace("+00:00", "Z"),
            })

        if album_meta is None:
            continue
        if not album_meta["album_mbid"]:
            print(f"⚠️ Skipped (Release MBID is missing): {root}")
            skipped_missing_release_mbid += 1
            continue

        album_name = album_meta["album_name"] or os.path.basename(root)
        artist_name = album_meta["artist_name"] or os.path.basename(os.path.dirname(root))

        if not album_meta["album_name"]:
            print(f"⚠️ Album tag is missing; using the folder name: {root}")
        if not album_meta["artist_name"]:
            print(f"⚠️ Album Artist tag is missing; using the parent folder name: {root}")

        library.append({
            "index_version": INDEX_VERSION,
            "album_name": album_name,
            "artist_name": artist_name,
            "album_mbid": album_meta["album_mbid"],
            "release_year": album_meta["release_year"],
            "country": album_meta["country"],
            "label": album_meta["label"],
            "media_format": album_meta["media_format"],
            "folder_path": relative_path,
            "tracks": tracks,
        })
        print(f"✅ Indexed: {artist_name} - {album_name} ({len(tracks)} tracks)")

    output_directory = os.path.dirname(output_path)
    if output_directory and not os.path.isdir(output_directory):
        raise SystemExit(f"Error: output folder does not exist: {output_directory}")
    temporary_path = output_path + ".tmp"
    try:
        with open(temporary_path, "w", encoding="utf-8") as output_file:
            json.dump(library, output_file, ensure_ascii=False, indent=4)
            output_file.write("\n")
        os.replace(temporary_path, output_path)
    finally:
        if os.path.exists(temporary_path):
            os.remove(temporary_path)

    elapsed_seconds = time.perf_counter() - started_at
    print(f"\n🎉 SUCCESS! The library index has been created: {output_path}")
    if skipped_missing_release_mbid:
        noun = "folder" if skipped_missing_release_mbid == 1 else "folders"
        print(
            f"⚠️ {skipped_missing_release_mbid} {noun} skipped "
            "because Release MBID is missing."
        )
    print(f"⏱️ Indexing completed in {elapsed_seconds:.2f} seconds.")


if __name__ == "__main__":
    main()
