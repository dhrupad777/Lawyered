# Kubernetes / GKE Manifests

The live Lawyered demo runs on **Cloud Run** (`deploy.ps1`) for cost and iteration speed. These manifests demonstrate that the same containers deploy unmodified to any **GKE** cluster — `kubectl apply -f kubernetes/` brings up the full stack with in-cluster service discovery between the Next.js frontend and the FastAPI backend.

## Architecture

```
                     ┌────────────────────────────┐
  Internet ──────►   │  Service: lawyered-frontend │  (LoadBalancer, :80 → :3000)
                     └──────────────┬─────────────┘
                                    │
                            Next.js API routes
                            proxy via BACKEND_URL
                                    │
                     ┌──────────────▼─────────────┐
                     │  Service: lawyered-backend  │  (ClusterIP, :8080)
                     └────────────────────────────┘
```

The frontend reads `BACKEND_URL=http://lawyered-backend:8080` from its env, which resolves via Kubernetes DNS to the backend Service in the same namespace. No public IP needed for the backend.

## Files

| File | Purpose |
|---|---|
| `backend-deployment.yaml` | FastAPI Deployment, port 8080, `/api/health` probes |
| `backend-service.yaml` | ClusterIP Service for in-cluster routing |
| `frontend-deployment.yaml` | Next.js Deployment, port 3000, points at backend Service |
| `frontend-service.yaml` | LoadBalancer Service — gets a public IP on GKE |
| `secrets.example.yaml` | Template Secret (do not commit real values) |

## Deploying to GKE

```bash
# 1. Create an Autopilot cluster (one-time)
gcloud container clusters create-auto lawyered \
  --region=us-central1

# 2. Build and push images to Artifact Registry
gcloud builds submit ./backend  --tag us-central1-docker.pkg.dev/PROJECT_ID/lawyered/lawyered-backend:latest
gcloud builds submit ./frontend --tag us-central1-docker.pkg.dev/PROJECT_ID/lawyered/lawyered-frontend:latest

# 3. Update the `image:` fields in backend-deployment.yaml and frontend-deployment.yaml
#    (replace REPLACE_ME with us-central1-docker.pkg.dev/PROJECT_ID/lawyered)

# 4. Create the backend secret (never commit real values)
kubectl create secret generic lawyered-backend-secrets \
  --from-literal=GOOGLE_API_KEY=your-google-api-key \
  --from-literal=COURTLISTENER_API_TOKEN=your-courtlistener-token

# 5. Apply the manifests
kubectl apply -f kubernetes/

# 6. Get the public IP
kubectl get service lawyered-frontend --watch
```

## Validation (no cluster needed)

```bash
kubectl apply --dry-run=client -f kubernetes/
```

## Future work

HorizontalPodAutoscaler, Ingress + managed TLS cert, NetworkPolicy, and Workload Identity + Secret Manager CSI driver in place of plain Kubernetes Secrets.
