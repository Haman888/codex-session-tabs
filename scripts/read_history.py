"""Read metadata through Python SQLite when the system sqlite3 reader fails."""
from pathlib import Path
import json
import sqlite3
import sys


def main():
    database, sql = sys.argv[1:]
    connection = sqlite3.connect(Path(database).resolve().as_uri() + '?mode=ro', uri=True, timeout=3)
    try:
        connection.execute('PRAGMA query_only=ON')
        connection.row_factory = sqlite3.Row
        rows = [dict(row) for row in connection.execute(sql)]
        print(json.dumps(rows, ensure_ascii=False))
    finally:
        connection.close()


if __name__ == '__main__':
    try:
        main()
    except (sqlite3.Error, OSError, ValueError):
        # Do not print paths, queries, transcript data or connection details.
        print('History metadata is temporarily unavailable.', file=sys.stderr)
        sys.exit(2)
