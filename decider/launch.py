"""asha's launcher of the decision model (docs/plans/decider-tool.md R3; probe P5's decider-launch.py, 2026-10-02).

Serves strands-decider 0.1.0's own app (strands_decider.server.create_app, unchanged) with uvicorn on a Unix-domain
socket instead of `strands-decider serve`'s unauthenticated TCP port. The daemon creates the socket's folder 0700
(R4); uvicorn makes the socket itself 0666, so the folder is what keeps other OS users out. One worker, and uvicorn's
log level `warning`, so no access line is written (R13: a request's text never reaches a log). The daemon sends one
request at a time (R8): two at once crash torch's MPS backend (probes P3, P3b).

Usage: python launch.py <checkpoint dir> <socket path> mps
Every argument is required and the device is named, never detected (PRINCIPLES §9).
"""

import sys

import uvicorn
from strands_decider.server import create_app

if len(sys.argv) != 4 or sys.argv[3] != "mps":
    sys.exit("usage: launch.py <checkpoint dir> <socket path> mps")
checkpoint, socket_path, device = sys.argv[1:]
app = create_app(checkpoint, device=device, model_name="strands-decider-2B-hobson-v19")
# One worker: the model owns the GPU (as strands_decider.server.serve does).
uvicorn.run(app, uds=socket_path, workers=1, log_level="warning")
