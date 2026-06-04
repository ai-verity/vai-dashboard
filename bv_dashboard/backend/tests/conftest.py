import os
import sys

# Make the backend modules (main.py, vlm.py, ai_metrics.py) importable when
# pytest is run from anywhere — they live one directory up from tests/.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
