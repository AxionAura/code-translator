"""Exception handling: typed handlers, else/finally structure, custom hierarchy."""


class AppError(Exception):
    pass


class ConfigError(AppError):
    pass


def parse_port(raw: str) -> int:
    port = int(raw)
    if port < 0 or port > 65535:
        raise ValueError(f"port out of range: {raw}")
    return port


def load_config(raw: str) -> str:
    try:
        port = parse_port(raw)
    except ValueError as error:
        return f"invalid: {error}"
    except TypeError:
        return "wrong type"
    else:
        return f"ok: {port}"
    finally:
        pass


def rereport(raw: str) -> int:
    try:
        return parse_port(raw)
    except ValueError:
        raise ConfigError("configuration invalid")


def cleanup_safe(action: int) -> int:
    try:
        return action * 2
    finally:
        pass
