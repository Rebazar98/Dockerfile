# Imagen base con Node y GDAL (Debian slim)
FROM node:20-slim

ARG DEBIAN_FRONTEND=noninteractive
# GDAL (ogr2ogr), Python bindings, curl, certificados y bash
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      gdal-bin python3-gdal curl ca-certificates bash && \
    rm -rf /var/lib/apt/lists/*

# Directorio de trabajo
WORKDIR /app
ENV NODE_ENV=production

# Dependencias
COPY package*.json ./
# Usa install (no ci) porque no tienes lockfile
RUN npm install --omit=dev

# Copiar TODO el código (incluye server.js y cualquier otro archivo)
COPY . .

# Puerto de la API
ENV PORT=8080
EXPOSE 8080

# Healthcheck para que Railway marque el servicio como healthy
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://localhost:${PORT}/healthz || exit 1

# Arranque
CMD ["node", "server.js"]
