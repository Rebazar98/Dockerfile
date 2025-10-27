# Imagen base con Node y permisos root para instalar GDAL
FROM node:20-alpine

# Instalar GDAL (ogr2ogr)
RUN apk add --no-cache gdal curl bash

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
