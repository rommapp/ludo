"""Text encoding of the shared settings.ini file."""
import locale
import os


# Preserve the existing default encoding on POSIX.
SETTINGS_ENCODING = 'utf-8' if os.name == 'nt' else None


def read_settings(parser, path):
    if os.name != 'nt':
        parser.read(path)
        return
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return  # ConfigParser.read also accepts a missing file.
    try:
        text = data.decode('utf-8-sig')
    except UnicodeDecodeError:
        # Older Windows installations wrote in the local ANSI code page.
        text = data.decode(locale.getencoding())
    parser.read_string(text, source=str(path))
