// Every /api/* request goes to the forum API (functions/_lib/app.js).
import { handle } from '../_lib/app.js';

export const onRequest = ({ request, env }) => handle(request, env);
