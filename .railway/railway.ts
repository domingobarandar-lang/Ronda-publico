import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

// Configuración de Railway (Infrastructure as Code). Railway NO la lee al
// desplegar: se aplica con `railway config plan` + `railway config apply`.
// Ver entrega/RAILWAY-IAC.md.
//
// OJO: lo que este archivo no declara, `apply` lo BORRA (variables, volumen,
// repo). Por eso declara todo el proyecto tal como está, importado con
// `railway config pull`. Agregar una variable nueva aquí antes de aplicar, o
// el apply la borra del servicio.

export default defineRailway(() => {
  const rondasQrVolume = volume("rondas-qr-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "us-west2",
    sizeMB: 5000,
  });

  // El nombre tiene que ser el del servicio en Railway. Si se renombra allá,
  // cambiarlo aquí: con el nombre viejo, `apply` borraría el servicio de
  // producción y crearía uno nuevo vacío.
  const ronda = service("Ronda", {
    source: github("domingobarandar-lang/rondas-qr", { checkSuites: false, rootDirectory: "app" }),
    // Sin seed: con la base vacía (volumen perdido, DB_PATH mal escrito) el
    // seed crearía las cuentas de demo, con PIN publicados en git, y la app
    // arrancaría «sana» escondiendo la pérdida. La demo es `npm run demo`.
    start: "node server.js",
    // Reinicio: ON_FAILURE con 10 reintentos, el valor por defecto de Railway.
    // No se declara: Railway guarda el defecto vacío y el plan lo vería como
    // un cambio pendiente para siempre.
    replicas: { "us-west2": 1 },
    networking: { privateNetworkEndpoint: "rondas-qr" },
    volumeMounts: { "/data": rondasQrVolume },
    // preserve(): deja el valor que ya tiene Railway; los secretos no van al repo.
    env: {
      ADMIN_TOTAL_CONDOMINIO: preserve(),
      ADMIN_TOTAL_NOMBRE: preserve(),
      ADMIN_TOTAL_PIN: preserve(),
      ADMIN_TOTAL_USUARIO: preserve(),
      CONTACTO_PRIVACIDAD: preserve(),
      DB_PATH: preserve(),
      FABRICA_PIN: preserve(),
      FABRICA_USUARIO: preserve(),
      GMAIL_CLIENT_ID: preserve(),
      GMAIL_CLIENT_SECRET: preserve(),
      GMAIL_FROM: preserve(),
      GMAIL_REFRESH_TOKEN: preserve(),
      INFORME_DIA: preserve(),
      INFORME_HORA: preserve(),
      INFORME_TO: preserve(),
      RESPALDO_TO: preserve(),
      SENTRY_DSN: preserve(),
      SENTRY_TOKEN_LECTURA: preserve(),
    },
  });

  return project("rondas-qr", {
    resources: [ronda, rondasQrVolume],
  });
});
