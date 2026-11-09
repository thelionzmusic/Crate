"""Crate — a fast DJ library manager that exports straight to Pioneer players."""
import os

# One BLAS/FFT thread per process: parallelism comes from the process pool, so
# letting numpy spawn its own threads in every worker only causes contention.
for _var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_var, "1")

__version__ = "1.7.0"
