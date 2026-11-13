// Single Vercel Function for the whole API; vercel.json rewrites /api/* here.
import { handle } from '../server/router.js'
import { productionDeps } from '../server/context.js'

const run = (request: Request) => handle(request, productionDeps())

export const GET = run
export const POST = run
export const PATCH = run
export const DELETE = run
