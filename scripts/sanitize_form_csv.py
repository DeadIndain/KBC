#!/usr/bin/env python3
import argparse
import csv
import json
import mimetypes
import os
import re
import http.cookiejar
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


LETTER_SET = {"A", "B", "C", "D"}


def normalize_text(value: str) -> str:
    lowered = value.strip().lower()
    lowered = lowered.replace("\u2013", "-").replace("\u2014", "-")
    return re.sub(r"\s+", " ", lowered)


def normalize_for_compare(value: str) -> str:
    text = normalize_text(value)
    text = re.sub(r"\s*[-:,.;!?()\[\]{}]+\s*", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def normalize_compact(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", normalize_text(value))


def parse_correct_letter(raw_value: str, options: dict) -> str:
    raw = normalize_text(raw_value)
    if not raw:
        return ""

    if raw.upper() in LETTER_SET:
        return raw.upper()

    match = re.search(r"\boption\s*([a-d])\b", raw, flags=re.IGNORECASE)
    if match:
        return match.group(1).upper()

    match = re.search(r"\b([a-d])\b", raw, flags=re.IGNORECASE)
    if match and len(raw) <= 3:
        return match.group(1).upper()

    cleaned_raw = normalize_for_compare(raw_value)
    for letter, option_text in options.items():
        if cleaned_raw == normalize_for_compare(option_text):
            return letter

    compact_raw = normalize_compact(raw_value)
    for letter, option_text in options.items():
        if compact_raw and compact_raw == normalize_compact(option_text):
            return letter

    # Fallback: substring match for noisy forms like "Option C - foo"
    for letter, option_text in options.items():
        candidate = normalize_for_compare(option_text)
        if candidate and candidate in cleaned_raw:
            return letter

    return ""


def guess_extension(content_type: str, url_path: str, content_disposition: str) -> str:
    cd_filename = ""
    if content_disposition:
        # Handles: attachment; filename="file.jpg"
        match = re.search(r'filename="?([^";]+)"?', content_disposition)
        if match:
            cd_filename = match.group(1)

    ext = ""
    if cd_filename:
        ext = Path(cd_filename).suffix

    if not ext:
        ext = Path(url_path).suffix

    if not ext and content_type:
        ext = mimetypes.guess_extension(content_type) or ""

    if ext == ".jpe":
        ext = ".jpg"

    return ext.lower()


def media_subfolder_from_ext_or_type(ext: str, content_type: str) -> str:
    video_exts = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}
    audio_exts = {".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"}
    image_exts = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"}

    if ext in video_exts:
        return "video"
    if ext in audio_exts:
        return "audio"
    if ext in image_exts:
        return "images"

    if content_type.startswith("video/"):
        return "video"
    if content_type.startswith("audio/"):
        return "audio"
    return "images"


def sanitize_filename(name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.")
    return cleaned or "asset"


def unique_file_path(target_dir: Path, base_name: str, ext: str) -> Path:
    preferred = target_dir / f"{base_name}{ext}"
    if preferred.exists():
        return preferred

    index = 2
    candidate = target_dir / f"{base_name}-{index}{ext}"
    while candidate.exists():
        index += 1
        candidate = target_dir / f"{base_name}-{index}{ext}"
    return preferred


def google_drive_direct_url(link: str) -> str:
    parsed = urllib.parse.urlparse(link)
    query = urllib.parse.parse_qs(parsed.query)
    file_id = ""

    if "id" in query and query["id"]:
        file_id = query["id"][0]
    else:
        match = re.search(r"/d/([A-Za-z0-9_-]+)", parsed.path)
        if match:
            file_id = match.group(1)

    if not file_id:
        return link

    return f"https://drive.google.com/uc?export=download&id={file_id}"


def google_drive_file_id(link: str) -> str:
    parsed = urllib.parse.urlparse(link)
    query = urllib.parse.parse_qs(parsed.query)
    if "id" in query and query["id"]:
        return query["id"][0]

    match = re.search(r"/d/([A-Za-z0-9_-]+)", parsed.path)
    if match:
        return match.group(1)
    return ""


def fetch_url_with_possible_drive_confirm(url: str, original_link: str) -> tuple[bytes, str, str]:
    cookie_jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))
    opener.addheaders = [
        ("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"),
    ]

    with opener.open(url, timeout=30) as resp:
        body = resp.read()
        content_type = resp.headers.get_content_type() or ""
        content_disposition = resp.headers.get("Content-Disposition", "")

    if not content_type.startswith("text/html"):
        return body, content_type, content_disposition

    file_id = google_drive_file_id(original_link)
    if not file_id:
        return body, content_type, content_disposition

    html = body.decode("utf-8", errors="ignore")
    confirm_match = re.search(r"confirm=([0-9A-Za-z_]+)", html)
    if not confirm_match:
        return body, content_type, content_disposition

    confirm = confirm_match.group(1)
    confirmed_url = f"https://drive.google.com/uc?export=download&confirm={confirm}&id={file_id}"
    with opener.open(confirmed_url, timeout=30) as resp:
        body2 = resp.read()
        content_type2 = resp.headers.get_content_type() or ""
        content_disposition2 = resp.headers.get("Content-Disposition", "")
    return body2, content_type2, content_disposition2


def download_media(url: str, media_root: Path, row_index: int) -> tuple[str, str]:
    if not url:
        return "", ""

    direct_url = google_drive_direct_url(url.strip())
    body, content_type, content_disposition = fetch_url_with_possible_drive_confirm(direct_url, url)
    if content_type.startswith("text/html"):
        raise ValueError("downloaded HTML page instead of media (check Drive sharing permissions)")

    ext = guess_extension(content_type, urllib.parse.urlparse(direct_url).path, content_disposition)
    subfolder = media_subfolder_from_ext_or_type(ext, content_type)

    target_dir = media_root / subfolder
    target_dir.mkdir(parents=True, exist_ok=True)

    base_name = sanitize_filename(f"q{row_index}")
    if not ext:
        ext = ".bin"
    file_path = unique_file_path(target_dir, base_name, ext)

    with open(file_path, "wb") as out:
        out.write(body)

    web_path = f"/media/{subfolder}/{file_path.name}"
    return web_path, ""


def build_json_row(index: int, row: dict) -> dict:
    return {
        "id": index,
        "question": row["question"],
        "options": {
            "A": row["option_a"],
            "B": row["option_b"],
            "C": row["option_c"],
            "D": row["option_d"],
        },
        "correct": row["correct"],
        "difficulty": row["difficulty"],
        "media": row["media"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Sanitize KBC form CSV and export cleaned CSV + JSON.")
    parser.add_argument("--input", required=True, help="Path to original CSV.")
    parser.add_argument("--output-csv", required=True, help="Path to cleaned CSV output.")
    parser.add_argument("--output-json", required=True, help="Path to cleaned JSON output.")
    parser.add_argument(
        "--issues-file",
        default="data/questions_sanitized_issues.txt",
        help="Path to write sanitation/download issues.",
    )
    parser.add_argument(
        "--media-root",
        default="public/media",
        help="Local media root directory where files will be downloaded.",
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    output_csv_path = Path(args.output_csv)
    output_json_path = Path(args.output_json)
    issues_file_path = Path(args.issues_file)
    media_root = Path(args.media_root)

    output_csv_path.parent.mkdir(parents=True, exist_ok=True)
    output_json_path.parent.mkdir(parents=True, exist_ok=True)
    issues_file_path.parent.mkdir(parents=True, exist_ok=True)
    media_root.mkdir(parents=True, exist_ok=True)

    cleaned_rows = []
    issues = []

    with open(input_path, newline="", encoding="utf-8") as infile:
        reader = csv.DictReader(infile)
        for idx, raw_row in enumerate(reader, start=1):
            row = {k.strip().lower(): (v or "").strip() for k, v in raw_row.items()}

            options = {
                "A": row.get("option a", ""),
                "B": row.get("option b", ""),
                "C": row.get("option c", ""),
                "D": row.get("option d", ""),
            }

            cleaned = {
                "question": row.get("question", ""),
                "option_a": options["A"],
                "option_b": options["B"],
                "option_c": options["C"],
                "option_d": options["D"],
                "correct": parse_correct_letter(row.get("correct answer", ""), options),
                "difficulty": row.get("difficulty", ""),
                "media": "",
            }

            media_link = row.get("any file if image/audio/video", "")
            if media_link:
                try:
                    local_media_path, _ = download_media(media_link, media_root, idx)
                    cleaned["media"] = local_media_path
                except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
                    issues.append(f"Row {idx}: media download failed ({media_link}) -> {exc}")

            if not cleaned["correct"]:
                issues.append(
                    f"Row {idx}: could not normalize correct answer '{row.get('correct answer', '')}'"
                )

            if not cleaned["question"] or not all(options.values()):
                issues.append(f"Row {idx}: missing question/options fields")

            cleaned_rows.append(cleaned)

    csv_fields = [
        "question",
        "option_a",
        "option_b",
        "option_c",
        "option_d",
        "correct",
        "difficulty",
        "media",
    ]

    with open(output_csv_path, "w", newline="", encoding="utf-8") as outfile:
        writer = csv.DictWriter(outfile, fieldnames=csv_fields)
        writer.writeheader()
        writer.writerows(cleaned_rows)

    json_rows = [build_json_row(i, row) for i, row in enumerate(cleaned_rows, start=1)]
    with open(output_json_path, "w", encoding="utf-8") as jf:
        json.dump(json_rows, jf, ensure_ascii=False, indent=2)

    print(f"Sanitized rows: {len(cleaned_rows)}")
    print(f"Clean CSV: {output_csv_path}")
    print(f"Clean JSON: {output_json_path}")
    if issues:
        with open(issues_file_path, "w", encoding="utf-8") as ef:
            ef.write("\n".join(issues) + "\n")
        print("Issues:")
        for issue in issues:
            print(f"- {issue}")
        print(f"Issues file: {issues_file_path}")
    else:
        with open(issues_file_path, "w", encoding="utf-8") as ef:
            ef.write("No issues\n")
        print("Issues: none")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())