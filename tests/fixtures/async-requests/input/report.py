from fetcher import fetch_title


def build_report(urls: list[str]) -> list:
    titles = []
    for url in urls:
        titles.append(fetch_title(url))
    return titles
