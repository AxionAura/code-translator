"""WS F golden: sync-to-async boundary propagation through the module graph."""
import requests


def fetch_title(url: str) -> str:
    response = requests.get(url)
    return response.text
