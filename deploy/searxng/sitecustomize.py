"""Disable Python logging before SearXNG/Granian imports.

debug=false still configures WARNING. This process-local override survives
basicConfig/setLevel calls; stdout/stderr are independently discarded too.
"""
import logging
import sys

logging.disable(sys.maxsize)
logging.getLogger().handlers.clear()
logging.getLogger().addHandler(logging.NullHandler())
logging.lastResort = None
