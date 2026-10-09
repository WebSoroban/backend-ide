import prisma from '../lib/prisma'
import { adminEmails } from '../lib/admin'

/**
 * Adoption of the x402 kit outside the WebSoroban team (KR: external projects)
 * and time from creating an endpoint to its first real paid request (KR: same-day
 * integration).
 *
 * An account counts as an external adopter only when one of its endpoints has
 * settled a payment from a payer other than the endpoint's own payout address.
 * Self-payments and team accounts never count, so the number cannot be inflated
 * by testing.
 */
export const ADOPTION_TARGET = 10

function listEnv(name: string): string[] {
  return (process.env[name] || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
}

/** Team accounts: ADMIN_EMAILS, X402_INTERNAL_EMAILS, and any X402_INTERNAL_DOMAINS. */
export function isInternalEmail(email: string): boolean {
  const value = email.toLowerCase()
  if (adminEmails().includes(value) || listEnv('X402_INTERNAL_EMAILS').includes(value)) return true
  const domain = value.split('@')[1] || ''
  return listEnv('X402_INTERNAL_DOMAINS').some((internal) => domain === internal || domain.endsWith(`.${internal}`))
}

export function maskEmail(email: string): string {
  const [name, domain] = email.split('@')
  if (!domain) return '***'
  return `${name.slice(0, 1)}***@${domain}`
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

function isoWeek(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const weekday = day.getUTCDay() || 7
  day.setUTCDate(day.getUTCDate() + 4 - weekday)
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((day.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

interface FirstPaid {
  endpointId: string
  userId: string
  network: string
  endpointCreatedAt: Date
  firstPaidAt: Date
  source: string | null
}

export async function adoptionReport() {
  // First settlement per endpoint from a payer that is not the endpoint itself.
  const firstPaid = await prisma.$queryRaw<FirstPaid[]>`
    SELECT DISTINCT ON (e."id")
      e."id" AS "endpointId", e."userId" AS "userId", e."network" AS "network",
      e."createdAt" AS "endpointCreatedAt", ev."createdAt" AS "firstPaidAt",
      ev."metadata"->>'source' AS "source"
    FROM "X402Endpoint" e
    JOIN "X402Event" ev ON ev."endpointId" = e."id"
    WHERE ev."type" = 'settlement' AND ev."status" = 'settled'
      AND ev."payer" IS NOT NULL AND ev."payer" <> e."payTo"
    ORDER BY e."id", ev."createdAt" ASC
  `
  const endpoints = await prisma.x402Endpoint.findMany({
    select: { id: true, userId: true, user: { select: { email: true } } },
  })
  const challenged = await prisma.x402Event.groupBy({ by: ['endpointId'], where: { type: 'request' } })
  const internal = new Set(endpoints.filter((endpoint) => isInternalEmail(endpoint.user.email)).map((endpoint) => endpoint.userId))
  const emailByUser = new Map(endpoints.map((endpoint) => [endpoint.userId, endpoint.user.email]))
  const userByEndpoint = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint.userId]))

  const external = (userId: string) => !internal.has(userId)
  const accountsWithEndpoint = new Set(endpoints.map((endpoint) => endpoint.userId).filter(external))
  const accountsWithChallenge = new Set(
    challenged.map((row) => userByEndpoint.get(row.endpointId)).filter((userId): userId is string => Boolean(userId && external(userId))),
  )

  // Each adopter is dated by their earliest qualifying payment.
  const adopters = new Map<string, FirstPaid & { viaSdk: boolean }>()
  for (const row of firstPaid) {
    if (!external(row.userId)) continue
    const current = adopters.get(row.userId)
    const viaSdk = row.source === 'managed_proxy' || Boolean(current?.viaSdk)
    if (!current || row.firstPaidAt < current.firstPaidAt) adopters.set(row.userId, { ...row, viaSdk })
    else current.viaSdk = viaSdk
  }

  const minutes = [...adopters.values()]
    .map((row) => (row.firstPaidAt.getTime() - row.endpointCreatedAt.getTime()) / 60_000)
    .sort((left, right) => left - right)
  const weekly = new Map<string, number>()
  for (const row of adopters.values()) {
    const week = isoWeek(row.firstPaidAt)
    weekly.set(week, (weekly.get(week) || 0) + 1)
  }

  return {
    generatedAt: new Date().toISOString(),
    target: ADOPTION_TARGET,
    externalAdopters: adopters.size,
    internalAccountsExcluded: internal.size,
    funnel: {
      accountsWithEndpoint: accountsWithEndpoint.size,
      accountsWithChallenge: accountsWithChallenge.size,
      accountsWithPaidRequest: adopters.size,
      accountsViaSdk: [...adopters.values()].filter((row) => row.viaSdk).length,
    },
    timeToFirstPaidRequest: {
      measuredFrom: 'endpoint creation',
      samples: minutes.length,
      medianMinutes: percentile(minutes, 50),
      p75Minutes: percentile(minutes, 75),
      within30Minutes: minutes.filter((value) => value <= 30).length,
    },
    weeklyNewAdopters: [...weekly.entries()].sort().map(([week, count]) => ({ week, count })),
    adopters: [...adopters.values()]
      .sort((left, right) => left.firstPaidAt.getTime() - right.firstPaidAt.getTime())
      .map((row) => ({
        account: maskEmail(emailByUser.get(row.userId) || ''),
        network: row.network,
        viaSdk: row.viaSdk,
        firstPaidAt: row.firstPaidAt.toISOString(),
        minutesToFirstPaid: Math.round((row.firstPaidAt.getTime() - row.endpointCreatedAt.getTime()) / 60_000),
      })),
  }
}
