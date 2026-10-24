#!/usr/bin/env python3
"""Manage this checkout's two login services without storing secrets in plists."""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
DOMAIN = f"gui/{os.getuid()}"
LABELS = {name: f"org.caotc.cyber-dm.{name}" for name in ("server", "tunnel")}
AGENTS = Path.home() / "Library/LaunchAgents"


def run(*args, check=True):
    return subprocess.run(["launchctl", *args], check=check)


def install():
    node = shutil.which("node")
    if not node:
        raise SystemExit("Node.js is not on PATH")
    for relative in (".data/deployment.env", ".data/cloudflared.yml",
                     ".data/bin/cloudflared", "dist/index.html"):
        if not (ROOT / relative).is_file():
            raise SystemExit(f"Missing {relative}; finish deployment preparation first")
    commands = {
        "server": [node, "--env-file=.data/deployment.env", "--import", "tsx", "src/server/index.ts"],
        "tunnel": [str(ROOT / ".data/bin/cloudflared"), "--no-autoupdate", "tunnel",
                   "--config", str(ROOT / ".data/cloudflared.yml"), "run", "cyber-dm"],
    }
    logs = ROOT / ".data/logs"
    logs.mkdir(parents=True, exist_ok=True, mode=0o700)
    AGENTS.mkdir(parents=True, exist_ok=True)
    for name, label in LABELS.items():
        path = AGENTS / f"{label}.plist"
        if path.exists():
            previous = plistlib.loads(path.read_bytes())
            if previous.get("WorkingDirectory") != str(ROOT):
                raise SystemExit(f"Refusing to replace service belonging to another checkout: {path}")
        data = {
            "Label": label, "ProgramArguments": commands[name],
            "WorkingDirectory": str(ROOT), "RunAtLoad": True, "KeepAlive": True,
            "ThrottleInterval": 10, "Umask": 0o077,
            "StandardOutPath": str(logs / f"{name}.stdout.log"),
            "StandardErrorPath": str(logs / f"{name}.stderr.log"),
            "EnvironmentVariables": {"PATH": f"{Path(node).parent}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"},
        }
        # Boot out only an already registered copy of this exact service.
        present = subprocess.run(["launchctl", "print", f"{DOMAIN}/{label}"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if present.returncode == 0:
            run("bootout", f"{DOMAIN}/{label}")
        path.write_bytes(plistlib.dumps(data))
        path.chmod(0o600)
        run("bootstrap", DOMAIN, str(path))
        print(f"Installed {label}")


def main():
    if sys.platform != "darwin":
        raise SystemExit("This command requires macOS")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "status", "uninstall"))
    action = parser.parse_args().action
    if action == "install":
        install()
    else:
        for label in LABELS.values():
            if action == "status":
                run("print", f"{DOMAIN}/{label}", check=False)
            else:
                path = AGENTS / f"{label}.plist"
                if path.exists():
                    data = plistlib.loads(path.read_bytes())
                    if data.get("WorkingDirectory") != str(ROOT):
                        raise SystemExit(f"Service belongs to another checkout: {path}")
                    run("bootout", f"{DOMAIN}/{label}", check=False)
                    path.unlink()
                    print(f"Removed {label}; local data and tunnel DNS preserved")


if __name__ == "__main__":
    main()
