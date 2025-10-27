# Imagen base con Node y permisos root para instalar GDAL
FROM node:20-alpine

# Instalar GDAL (ogr2ogr)
RUN apk add --no-cache gdal curl bash

# Crear dir de trabajo
WORKDIR /app

# Copiar package y código
COPY package*.json ./
RUN npm ci --only=production
COPY server.js ./

# Puerto de la API
ENV PORT=8080
EXPOSE 8080

# Arranque
CMD ["node", "server.js"]
