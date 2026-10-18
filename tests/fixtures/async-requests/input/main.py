from report import build_report


def run() -> list:
    return build_report(["https://example.test/a", "https://example.test/b"])
