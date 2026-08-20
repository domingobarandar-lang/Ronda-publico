#!/usr/bin/env node
// Genera el GMAIL_REFRESH_TOKEN una sola vez. Se corre en TU COMPUTADOR, NO en
// Railway: abre el navegador, pide permiso para mandar correo desde tu cuenta
// de Gmail, y al final imprime el refresh token para pegarlo en las
// variables de entorno de Railway.
//
// Antes de correrlo:
//   1. https://console.cloud.google.com/ → crea un proyecto (o usa uno).
//   2. "APIs & Services" → "Library" → habilita "Gmail API".
//   3. "APIs & Services" → "OAuth consent screen" → tipo "External", agrega
//      tu Gmail como "Test user" (mientras la app no esté publicada/verificada
//      no importa: igual funciona para tu propia cuenta).
//   4. "APIs & Services" → "Credentials" → "Create Credentials" →
//      "OAuth client ID" → tipo de aplicación "Desktop app". Copia el
//      Client ID y el Client Secret que te da.
//
// Uso (desde app/):
//   GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=yyy node scripts/obtener-refresh-token.js
//
// El script abre un puerto local (8080) para recibir la respuesta de Google
// — es el mismo mecanismo que usan las apps de escritorio, no requiere
// registrar la URL en ningún lado porque los client "Desktop app" de Google
// aceptan redirect a http://localhost:* automáticamente.
'use strict';

const http = require('http');
const { URL } = require('url');

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Faltan GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET (ver instrucciones al inicio de este archivo).');
  process.exit(1);
}

const PUERTO = 8080;
const redirectUri = `http://localhost:${PUERTO}`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, redirectUri);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.end('Google devolvió un error: ' + error + '. Cierra esta pestaña e inténtalo de nuevo.');
    server.close();
    console.error('Autorización rechazada:', error);
    process.exit(1);
  }
  if (!code) {
    res.end('No llegó el código. Cierra esta pestaña e inténtalo de nuevo.');
    return;
  }

  res.end('Listo, ya puedes cerrar esta pestaña y volver a la terminal.');
  server.close();

  intercambiarCodigo(code).catch(err => {
    console.error('Error pidiendo el token:', err.message);
    process.exit(1);
  });
});

async function intercambiarCodigo(code) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  });
  const j = await resp.json();
  if (!resp.ok) {
    console.error('Google respondió:', j);
    process.exit(1);
  }
  if (!j.refresh_token) {
    console.error(
      'Google no mandó refresh_token (pasa si ya habías autorizado esta app antes).\n'
      + 'Anda a https://myaccount.google.com/permissions, quita el acceso de "Rondas QR" '
      + '(o el nombre que le hayas puesto al OAuth client) y vuelve a correr este script.'
    );
    process.exit(1);
  }

  console.log('\n✅ Refresh token — guárdalo en Railway como GMAIL_REFRESH_TOKEN:\n');
  console.log(j.refresh_token);
  console.log('\nJunto con GMAIL_CLIENT_ID y GMAIL_CLIENT_SECRET, son las 3 variables que necesita el servidor.\n');
}

server.listen(PUERTO, () => {
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.send',
    access_type: 'offline',
    prompt: 'consent'
  });
  console.log('Abre esta URL en tu navegador y autoriza con la cuenta que va a mandar los informes:\n');
  console.log(authUrl);
  console.log('\nEsperando la autorización... (Ctrl+C para cancelar)');
});
