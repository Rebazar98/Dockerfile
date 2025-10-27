# Imagen base con Node y GDAL en Debian (no Alpine)
FROM node:20-slim

# Instalar GDAL (incluye ogr2ogr), curl y bash
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      gdal-bin python3-gdal curl bash && \
    rm -rf /var/lib/apt/lists/*

# Crear directorio de trabajo
WORKDIR /app

# Copiar archivos de configuración de npm
COPY package*.json ./

# Instalar dependencias (sin devDependencies)
RUN npm install --omit=dev

# Copiar el código fuente
COPY server.js ./

# Puerto de la API
ENV PORT=8080
EXPOSE 8080

# Comando de inicio
CMD ["node", "server.js"]
