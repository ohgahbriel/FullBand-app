"""FullBand API server.

Endpoints
  POST /api/jobs            {url, model?}      -> {id}
  GET  /api/jobs/{id}                          -> Job status (+ stem urls when done)
  GET  /api/files/{id}/{f}                     -> a separated stem file
  GET  /api/health                             -> {device, model}

Run:  python main.py   (or: uvicorn main:app --host 0.0.0.0 --port 8000)
"""
from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

import config
import pipeline
from pipeline import Job

app = FastAPI(title="FullBand")

# The Android/web client is served from a different origin, so allow all.
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

# One song at a time keeps VRAM predictable on a 4GB card.
_executor = ThreadPoolExecutor(max_workers=1)
_jobs: dict[str, Job] = {}


class CreateJob(BaseModel):
    url: str
    model: str | None = None


@app.get("/api/health")
def health():
    return {"device": pipeline._resolve_device(), "model": config.MODEL}


@app.post("/api/jobs")
def create_job(body: CreateJob):
    if not body.url.strip():
        raise HTTPException(400, "url is required")
    job = Job(id=uuid.uuid4().hex[:12], url=body.url.strip(),
              model=body.model or config.MODEL)
    _jobs[job.id] = job
    _executor.submit(pipeline.run, job)
    return {"id": job.id}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    return {
        "id": job.id, "status": job.status, "progress": round(job.progress, 3),
        "title": job.title, "stems": job.stems, "error": job.error,
    }


@app.get("/api/files/{job_id}/{filename}")
def get_file(job_id: str, filename: str):
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "no such job")
    # Resolve and confirm the path stays inside the job's stem directory.
    base = (job.dir() / "stems" / job.model / "source").resolve()
    target = (base / filename).resolve()
    if not str(target).startswith(str(base)) or not target.exists():
        raise HTTPException(404, "no such file")
    return FileResponse(target)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=config.HOST, port=config.PORT)
