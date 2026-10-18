"""Keep the test run out of the real ~/.config/ludo.

The backend resolves its config folder from HOME when it is imported and
opens debug.log there, so HOME has to point somewhere else before any test
module imports it. Tests that need their own HOME still set one per test.
"""
import os
import tempfile

os.environ["HOME"] = tempfile.mkdtemp(prefix="ludo-tests-home-")
