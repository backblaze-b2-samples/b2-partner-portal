from pathlib import Path
from typing import Optional
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_INSECURE_DEFAULTS = {"change-me-in-production", "changeme", "secret", ""}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    secret_key: str = "change-me-in-production"

    @field_validator("secret_key")
    @classmethod
    def secret_key_must_be_changed(cls, v: str) -> str:
        if v in _INSECURE_DEFAULTS or len(v) < 32:
            raise ValueError(
                "\n\n"
                "  *** STARTUP ABORTED ***\n"
                "  SECRET_KEY has not been set or is too weak.\n"
                "  Generate a secure key and set it in your .env file:\n\n"
                "    python3 -c \"import secrets; print(secrets.token_hex(32))\"\n\n"
                "  Then add to .env:\n"
                "    SECRET_KEY=<your-generated-key>\n"
            )
        return v
    data_dir: Path = Path("./data")
    host: str = "0.0.0.0"
    port: int = 8080

    # Created on first startup when no users exist
    initial_admin_email: str = "admin@example.com"
    initial_admin_password: str = "changeme123"

    # JWT settings
    access_token_expire_minutes: int = 15
    refresh_token_expire_days: int = 30

    # Expose Swagger UI and ReDoc — disable in production to reduce attack surface
    api_docs_enabled: bool = False

    # Show the "B2 API Call" inspector panels throughout the UI.
    # Useful for learning/demos; disable in production to reduce noise.
    api_inspector_enabled: bool = False

    # Credential vault — optional encrypted storage for B2 member credentials
    # Generate key with: python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    credential_vault_enabled: bool = False
    credential_vault_key: Optional[str] = None

    @property
    def db_path(self) -> Path:
        return self.data_dir / "portal.db"

    @property
    def reports_dir(self) -> Path:
        return self.data_dir / "reports"


settings = Settings()
