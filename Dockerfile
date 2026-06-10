FROM node:lts-alpine
# ffmpeg: para convertir audios webm (navegador) a ogg/opus que acepta WhatsApp
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3001
CMD ["node", "index.js"]
