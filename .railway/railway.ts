import { defineRailway, project, service } from "railway/iac";

// Generado con `railway config migrate --service rondas-QR` (dry-run) a partir
// de app/railway.json. Railway NO lee este archivo al desplegar: se aplica solo
// con `railway config plan` + `railway config apply`. Ver entrega/RAILWAY-IAC.md.
//
// Sin `source`, `env` ni `volumeMounts` a propósito: el repo, el Root Directory
// (`app`), las variables y el volumen en /data quedan como están en Railway.
// La política de reinicio (ON_FAILURE, 10 reintentos) ya está en el servicio.

// Este repo maneja solo sus propios recursos del entorno.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "rondas-QR";

export default defineRailway(() => {
  const rondas_QR = service("rondas-QR", {
    start: "node seed.js --si-vacio && node server.js",
  });
  return project("rondas-qr", {
    resources: [rondas_QR],
  });
});
