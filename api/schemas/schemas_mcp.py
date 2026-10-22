from pydantic import Field

from .overrides import BaseModel


class AuthorizeSchema(BaseModel):
    state: str = Field(...)
    # client_id is to identify the running MCP app for a client
    client_id: str = Field(...)
    # Confirmation code shown by the MCP client and typed in by the user. It is not part of the
    # authorize link, so a link started by someone else cannot be approved by just clicking it.
    user_code: str = Field(..., min_length=8, max_length=16)
    # sha256 (hex) of the normalized user code, from the authorize link.
    code_challenge: str = Field(..., pattern=r"^[0-9a-f]{64}$")
