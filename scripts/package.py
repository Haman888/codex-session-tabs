"""Build a local VSIX with the Python standard library, without npm downloads."""
from pathlib import Path
import json
import platform
import sys
import zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
HOST = "darwin-arm64" if platform.machine().lower() in ("arm64", "aarch64") else "darwin-x64"
TARGET = sys.argv[1] if len(sys.argv) > 1 else HOST
if TARGET not in ("darwin-arm64", "darwin-x64"):
    raise SystemExit(f"Unknown target {TARGET}; use darwin-arm64 or darwin-x64.")
package = json.loads((ROOT / "package.json").read_text())
translations = json.loads((ROOT / "package.nls.json").read_text())
description = package["description"]
if description.startswith("%") and description.endswith("%"):
    description = translations[description[1:-1]]
namespace = "http://schemas.microsoft.com/developer/vsx-schema/2011"
ET.register_namespace("", namespace)


def element(parent, tag, text=None, **attributes):
    child = ET.SubElement(parent, f"{{{namespace}}}{tag}", attributes)
    if text is not None:
        child.text = text
    return child


manifest = ET.Element(f"{{{namespace}}}PackageManifest", {"Version": "2.0.0"})
metadata = element(manifest, "Metadata")
element(metadata, "Identity", Id=package["name"], Version=package["version"], Publisher=package["publisher"], Language="en-US", TargetPlatform=TARGET)
element(metadata, "DisplayName", package["displayName"])
element(metadata, "Description", description)
element(metadata, "Categories", "Other")
properties = element(metadata, "Properties")
for key, value in {
    "Microsoft.VisualStudio.Code.Engine": package["engines"]["vscode"],
    "Microsoft.VisualStudio.Code.ExtensionDependencies": ",".join(package["extensionDependencies"]),
    "Microsoft.VisualStudio.Code.ExtensionKind": "ui",
}.items():
    element(properties, "Property", Id=key, Value=value)
installation = element(manifest, "Installation")
element(installation, "InstallationTarget", Id="Microsoft.VisualStudio.Code")
element(manifest, "Dependencies")
assets = element(manifest, "Assets")
for kind, filename in [
    ("Microsoft.VisualStudio.Code.Manifest", "package.json"),
    ("Microsoft.VisualStudio.Services.Content.Details", "README.md"),
    ("Microsoft.VisualStudio.Services.Content.License", "LICENSE"),
]:
    element(assets, "Asset", Type=kind, Path=f"extension/{filename}", Addressable="true")

content_ns = "http://schemas.openxmlformats.org/package/2006/content-types"
types = ET.Element("Types", xmlns=content_ns)
for suffix, mime in {"json": "application/json", "js": "application/javascript", "cjs": "application/javascript", "py": "text/plain", "md": "text/markdown", "svg": "image/svg+xml", "vsixmanifest": "text/xml"}.items():
    ET.SubElement(types, "Default", Extension=suffix, ContentType=mime)
ET.SubElement(types, "Override", PartName="/extension/LICENSE", ContentType="text/plain")

dist = ROOT / "dist"
dist.mkdir(exist_ok=True)
output = dist / f"{package['name']}-{package['version']}-{TARGET}.vsix"
files = ["package.json", "package.nls.json", "package.nls.ru.json", "i18n.js", "ui-language.js", "translations/en.json", "translations/ru.json", "extension.js", "sessions.js", "titles.js", "badges.js", "native-bridge.cjs", "update-core.js", "update-ui.js", "compatibility.json", "README.md", "README.ru.md", "LICENSE", "resources/sessions.svg", "scripts/native_adapter.py", "scripts/renderer_adapter.py", "scripts/update_package.py", "scripts/read_history.py", "test/update-probe.js"]
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("extension.vsixmanifest", ET.tostring(manifest, encoding="utf-8", xml_declaration=True))
    archive.writestr("[Content_Types].xml", ET.tostring(types, encoding="utf-8", xml_declaration=True))
    for filename in files:
        archive.write(ROOT / filename, f"extension/{filename}")
print(output)
