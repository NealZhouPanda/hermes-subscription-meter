"""Desktop/dashboard-only plugin; it intentionally exposes no agent tools."""


def register(ctx):
    """Keep the standalone plugin loader happy without adding agent tools."""
    return None
