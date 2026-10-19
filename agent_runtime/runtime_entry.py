import sys


def main():
    arguments = sys.argv[1:]
    if len(arguments) >= 2 and arguments[0] == "--mode" and arguments[1] in ("mcp-stdio", "mcp-http"):
        from novel_mcp.__main__ import main as run_stdio
        transport = ["--transport", "http"] if arguments[1] == "mcp-http" else []
        return run_stdio([*transport, *arguments[2:]])
    from novel_agent_runtime.__main__ import main as run_agent
    return run_agent()


if __name__ == "__main__":
    main()
