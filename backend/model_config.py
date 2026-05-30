"""Central model selection for all Lawyered agents.

The Elastic hackathon track is built on Gemini 3, so the default is a Gemini 3
model. Override with the LAWYERED_MODEL env var if your Vertex / AI Studio
access exposes a different Gemini 3 model id (e.g. set it in .env or via
Cloud Run --set-env-vars), or to fall back to gemini-2.5-flash:

    LAWYERED_MODEL=gemini-2.5-flash

Keep this module dependency-free so every agent module can import it cheaply.
"""

import os

# Default to Gemini 3. If this id isn't available in your project, set
# LAWYERED_MODEL to the Gemini 3 model id you have access to.
DEFAULT_MODEL = "gemini-3-pro-preview"

MODEL = os.getenv("LAWYERED_MODEL", DEFAULT_MODEL)
