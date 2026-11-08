"""Prepare a locally patched official VSIX only after a bundled SHA-256 match."""

import argparse
import gzip
import hashlib
import io
import json
import stat
import subprocess
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath


def read_metadata(response, limit=20 * 1024 * 1024):
    data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Marketplace response is too large.")
    if (response.headers.get("Content-Encoding") or "").lower() in ("gzip", "x-gzip"):
        # Bound decoded output as well as transfer bytes; never expand it all first.
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as stream:
            data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Marketplace response is too large.")
    return data


def latest_stable(target):
    body = json.dumps(
        {
            "filters": [
                {
                    "criteria": [{"filterType": 7, "value": "OpenAI.chatgpt"}],
                    "pageSize": 1,
                }
            ],
            "flags": 17,
        }
    ).encode()
    request = urllib.request.Request(
        "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json;api-version=7.2-preview.1",
            "Accept-Encoding": "identity",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        data = read_metadata(response)
        extension = json.loads(data)["results"][0]["extensions"][0]
    if (
        extension.get("publisher", {}).get("publisherName", "").lower() != "openai"
        or extension.get("extensionName") != "chatgpt"
    ):
        raise ValueError("Marketplace returned an unrelated extension.")
    versions = [
        item
        for item in extension["versions"]
        if item.get("targetPlatform") == target
        and not any(
            prop.get("key") == "Microsoft.VisualStudio.Code.PreRelease"
            and prop.get("value") == "true"
            for prop in item.get("properties", [])
        )
    ]
    versions.sort(
        key=lambda item: tuple(map(int, item["version"].split("."))), reverse=True
    )
    if not versions:
        raise ValueError(f"No stable Codex package was found for {target}.")
    return {"latest": versions[0]["version"]}


def download_official(profile, output):
    url = urllib.parse.urlparse(profile["url"])
    if (
        url.scheme != "https"
        or url.hostname != "marketplace.visualstudio.com"
        or not url.path.startswith(
            "/_apis/public/gallery/publishers/OpenAI/vsextensions/chatgpt/"
        )
    ):
        raise ValueError("Only the official Codex package source is accepted.")
    request = urllib.request.Request(
        profile["url"], headers={"Accept-Encoding": "identity"}
    )
    checksum = hashlib.sha256()
    size = 0
    # urllib on macOS respects the system proxy. TLS verification is never disabled.
    with urllib.request.urlopen(request, timeout=45) as response:
        if urllib.parse.urlparse(response.url).scheme != "https":
            raise ValueError("Insecure package redirect refused.")
        encoded = (response.headers.get("Content-Encoding") or "").lower() in (
            "gzip",
            "x-gzip",
        )
        stream = gzip.GzipFile(fileobj=response) if encoded else response
        with Path(output).open("xb") as file:
            while data := stream.read(1024 * 1024):
                size += len(data)
                if size > 1500 * 1024 * 1024:
                    raise ValueError("Package download is too large.")
                checksum.update(data)
                file.write(data)
    if checksum.hexdigest() != profile["vsixSha256"]:
        raise ValueError("Official package checksum mismatch.")
    return {"sha256": checksum.hexdigest(), "bytes": size}


def digest(file):
    value = hashlib.sha256()
    with Path(file).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def tree_digest(folder):
    records = []
    folder = Path(folder)
    for file in sorted(folder.rglob("*")):
        if file.is_symlink():
            raise ValueError("A staged package contains an unexpected link.")
        if file.is_file():
            records.append(
                [
                    file.relative_to(folder).as_posix(),
                    digest(file),
                    file.stat().st_mode & 0o111,
                ]
            )
    return hashlib.sha256(json.dumps(records).encode()).hexdigest()


def prepare(vsix, destination, helper, profile):
    vsix, destination, helper = map(Path, (vsix, destination, helper))
    if digest(vsix) != profile["vsixSha256"]:
        raise ValueError("Official package checksum mismatch; nothing installed.")
    if destination.exists():
        raise ValueError("Preparation requires a new isolated directory.")
    with zipfile.ZipFile(vsix) as archive:
        names = set()
        total = 0
        for member in archive.infolist():
            name = PurePosixPath(member.filename)
            normalized = name.as_posix()
            if (
                normalized in names
                or name.is_absolute()
                or ".." in name.parts
                or "\\" in member.filename
                or ":" in member.filename
                or stat.S_ISLNK(member.external_attr >> 16)
            ):
                raise ValueError("Unsafe or duplicate archive member.")
            names.add(normalized)
            total += member.file_size
        if len(names) > 50000 or total > 2 * 1024**3:
            raise ValueError("Package exceeds extraction limits.")
        package = json.loads(archive.read("extension/package.json"))
        if (
            package.get("publisher", "").lower() != "openai"
            or package.get("name") != "chatgpt"
            or package.get("version") != profile["version"]
        ):
            raise ValueError("Package identity does not match the approved version.")
        source = archive.read("extension/out/extension.js")
        if hashlib.sha256(source).hexdigest() != profile["sourceSha256"]:
            raise ValueError("Native editor does not match the approved build.")
        destination.mkdir(parents=True)
        extracted = destination / "extensions"
        extracted.mkdir()
        # Put the official extension under a real VS Code extensions directory.
        archive.extractall(destination / "unpacked")
        # zipfile does not restore executable permissions. The native Codex
        # app-server must be executable in the separate runtime test as well.
        for member in archive.infolist():
            if not member.is_dir():
                target = destination / "unpacked" / member.filename
                target.chmod(0o755 if (member.external_attr >> 16) & 0o111 else 0o644)
        vendor = extracted / "openai.chatgpt"
        (destination / "unpacked/extension").rename(vendor)
        # A8 fix: Use python3 -I to ignore user site-packages
        command = ["python3", "-I", str(helper / "scripts/native_adapter.py")]
        if profile.get("platform"):
            command += ["--platform", profile["platform"]]
        process = subprocess.run(
            command + ["--extension-dir", str(vendor)],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if process.returncode:
            raise ValueError("Adapter refused this package.")
        if digest(vendor / "out/extension.js") != profile["patchedSourceSha256"]:
            raise ValueError("Unexpected patched editor checksum.")
        patched = destination / "codex-patched.vsix"
        # Package the exact staged files, including any future verified renderer
        # asset changes. Never test one UI and ship the original unpatched asset.
        staged_files = {
            "extension/" + f.relative_to(vendor).as_posix(): f
            for f in vendor.rglob("*")
            if f.is_file()
        }
        with zipfile.ZipFile(
            patched, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1
        ) as output:
            for member in archive.infolist():
                if member.filename in staged_files:
                    output.write(staged_files.pop(member.filename), member.filename)
                else:
                    output.writestr(member, archive.read(member))
            for name, file in staged_files.items():
                output.write(file, name)
    return {
        "vendor": str(vendor),
        "extensionsDir": str(extracted),
        "vsix": str(patched),
        "sha256": digest(patched),
        "version": profile["version"],
        "treeSha256": tree_digest(vendor),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vsix")
    parser.add_argument("--destination")
    parser.add_argument("--helper")
    parser.add_argument("--profile")
    parser.add_argument("--verify-tree")
    parser.add_argument("--expected-tree")
    parser.add_argument("--latest", action="store_true")
    parser.add_argument("--platform")
    parser.add_argument("--download-profile")
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.latest:
        if not args.platform:
            parser.error("--platform is required with --latest.")
        print(json.dumps(latest_stable(args.platform)))
    elif args.download_profile:
        if not args.output:
            parser.error("--output is required for a download.")
        print(
            json.dumps(
                download_official(json.loads(args.download_profile), args.output)
            )
        )
    elif args.verify_tree:
        if tree_digest(args.verify_tree) != args.expected_tree:
            raise ValueError("The staged package changed during testing.")
        print(json.dumps({"verified": True}))
    else:
        if not all([args.vsix, args.destination, args.helper, args.profile]):
            parser.error(
                "Package, destination, helper and approved profile are required."
            )
        print(
            json.dumps(
                prepare(
                    args.vsix,
                    args.destination,
                    args.helper,
                    json.loads(Path(args.profile).read_text()),
                )
            )
        )
