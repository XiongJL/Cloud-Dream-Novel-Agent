"""Independent stdio entry; never import novel_agent_runtime.__main__."""
from __future__ import annotations

import argparse
import os
import sys


def main(argv=None):
    # Frozen Python on Chinese Windows otherwise uses the local ANSI code page
    # for diagnostic JSON, while the parent process expects UTF-8.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--smoke" in argv:
        from .smoke import main as smoke
        argv.remove("--smoke")
        return smoke(argv)
    parser = argparse.ArgumentParser(description="CloudDream Python FastMCP stdio gateway")
    parser.add_argument("--runtime-file", help="Explicit desktop automation runtime.json")
    parser.add_argument("--transport", choices=["stdio", "http"], default="stdio")
    parser.add_argument("--port", type=int, default=18765)
    parser.add_argument("--parent-stdio", action="store_true", help="Exit when the desktop pipe closes")
    args = parser.parse_args(argv)
    from .server import build_mcp_server
    server = build_mcp_server(args.runtime_file)
    if args.transport == "http":
        if not 1024 <= args.port <= 65535:
            parser.error("port must be between 1024 and 65535")
        from .http_transport import run_http
        return run_http(server, args.port, parent_stdio=args.parent_stdio)
    # SDK 1.x rewraps the binary stdio buffers. Its temporary wrappers can close
    # those buffers on EOF; PyInstaller then fails flushing sys.stdout at exit.
    # Give the SDK owned duplicates and restore the process handles afterwards.
    original_in, original_out = sys.stdin, sys.stdout
    owned_in = os.fdopen(os.dup(original_in.fileno()), "r", encoding="utf-8")
    owned_out = os.fdopen(os.dup(original_out.fileno()), "w", encoding="utf-8")
    try:
        sys.stdin, sys.stdout = owned_in, owned_out
        server.run(transport="stdio", show_banner=False, log_level="WARNING")
    finally:
        sys.stdin, sys.stdout = original_in, original_out
        owned_in.close()
        owned_out.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"[novel-editor-mcp] {error}", file=sys.stderr)
        raise SystemExit(1)
