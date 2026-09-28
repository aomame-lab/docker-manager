"""Application configuration via environment variables."""
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "Docker Manager"
    app_version: str = "1.0.0"
    host: str = "0.0.0.0"
    port: int = 8080
    docker_socket: str = "unix:///var/run/docker.sock"
    backup_dir: Path = Path("/app/backups")
    poll_interval: int = 5          # seconds, hint for frontend
    log_default_lines: int = 500
    max_upload_mb: int = 4096
    auth_token: str = ""            # empty = no authentication
    log_level: str = "INFO"


settings = Settings()
try:
    settings.backup_dir.mkdir(parents=True, exist_ok=True)
except OSError:
    settings.backup_dir = Path("./backups").resolve()
    settings.backup_dir.mkdir(parents=True, exist_ok=True)
