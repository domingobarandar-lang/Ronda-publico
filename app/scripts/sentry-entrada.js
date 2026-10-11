// Entrada mínima del bundle del navegador (public/vendor/sentry.js): solo `init`
// y `captureException`, sin transporte offline, tracing ni replay.
// Se arma con `npm run build:sentry` y el resultado se comitea.
import { init, captureException } from '@sentry/browser';

window.Sentry = { init, captureException };
