#!/usr/bin/python3
"""Pass an in-memory NPC configuration through an anonymous Linux descriptor."""

import os
import sys


def main():
    configuration = sys.stdin.buffer.read(4097)
    if not configuration or len(configuration) > 4096:
        return 1
    descriptor = os.memfd_create("sealed-notes-npc", flags=0)
    os.fchmod(descriptor, 0o600)
    remaining = memoryview(configuration)
    while remaining:
        remaining = remaining[os.write(descriptor, remaining):]
    os.lseek(descriptor, 0, os.SEEK_SET)
    os.set_inheritable(descriptor, True)
    npc = "/usr/local/bin/npc"
    os.execve(npc, [
        npc, "--config", f"/proc/self/fd/{descriptor}",
        "--log", "off", "--log_level", "off", "--log_path", "off",
        "--debug=false",
    ], {"PATH": "/usr/local/bin:/usr/bin:/bin"})


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(1)
