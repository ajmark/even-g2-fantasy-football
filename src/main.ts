import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

const SLEEPER_API = 'https://api.sleeper.app/v1'
const SLEEPER_USER_ID = '206491992631287808'

const MAIN_CONTAINER_ID = 1
const MAIN_CONTAINER_NAME = 'main'

interface SleeperState {
  week: number
  display_week?: number
  season: string
  league_season?: string
}

interface SleeperLeague {
  league_id: string
  name: string
}

interface SleeperRoster {
  roster_id: number
  owner_id: string | null
}

interface SleeperMatchup {
  roster_id: number
  matchup_id: number | null
  points: number
}

interface SleeperUser {
  user_id: string
  display_name: string
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${SLEEPER_API}${path}`)
  if (!res.ok) throw new Error(`Sleeper API ${path} failed: ${res.status}`)
  return res.json() as Promise<T>
}

async function fetchMatchupText(): Promise<string> {
  const state = await getJson<SleeperState>('/state/nfl')
  const season = state.league_season ?? state.season
  const week = state.display_week ?? state.week

  const leagues = await getJson<SleeperLeague[]>(`/user/${SLEEPER_USER_ID}/leagues/nfl/${season}`)
  const league = leagues[0]
  if (!league) return 'No active Sleeper\nleagues found.'

  const [rosters, matchups, users] = await Promise.all([
    getJson<SleeperRoster[]>(`/league/${league.league_id}/rosters`),
    getJson<SleeperMatchup[]>(`/league/${league.league_id}/matchups/${week}`),
    getJson<SleeperUser[]>(`/league/${league.league_id}/users`),
  ])

  const myRoster = rosters.find((r) => r.owner_id === SLEEPER_USER_ID)
  if (!myRoster) return `${league.name}\nNo roster found\nfor this user.`

  const myMatchup = matchups.find((m) => m.roster_id === myRoster.roster_id)
  if (!myMatchup || myMatchup.matchup_id === null) {
    return `${league.name}\nWeek ${week}\n\nNo matchup\nthis week (bye).`
  }

  const oppMatchup = matchups.find(
    (m) => m.matchup_id === myMatchup.matchup_id && m.roster_id !== myRoster.roster_id,
  )

  const nameByRosterId = (rosterId: number): string => {
    const roster = rosters.find((r) => r.roster_id === rosterId)
    const user = roster?.owner_id ? users.find((u) => u.user_id === roster.owner_id) : undefined
    return user?.display_name ?? `Team ${rosterId}`
  }

  const myPoints = myMatchup.points ?? 0
  const myName = nameByRosterId(myRoster.roster_id)

  if (!oppMatchup) {
    return `${league.name}\nWeek ${week}\n\n${myName}: ${myPoints.toFixed(2)}\n\nWaiting on opponent.`
  }

  const oppPoints = oppMatchup.points ?? 0
  const oppName = nameByRosterId(oppMatchup.roster_id)

  let status = 'TIED'
  if (myPoints > oppPoints) status = 'WINNING'
  else if (myPoints < oppPoints) status = 'LOSING'

  return [
    `${league.name}`,
    `Week ${week} - ${status}`,
    '',
    `${myName}: ${myPoints.toFixed(2)}`,
    `${oppName}: ${oppPoints.toFixed(2)}`,
    '',
    '(tap to refresh)',
  ].join('\n')
}

const mainText = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 4,
  containerID: MAIN_CONTAINER_ID,
  containerName: MAIN_CONTAINER_NAME,
  content: 'Loading fantasy\nfootball score...',
  isEventCapture: 1,
})

const bridge = await waitForEvenAppBridge()

const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
  containerTotalNum: 1,
  textObject: [mainText],
}))
console.log('Page created:', result === 0 ? 'success' : 'failed')

async function refreshScore() {
  const text = await fetchMatchupText().catch((err) => {
    console.error('Failed to fetch Sleeper matchup:', err)
    return 'Could not load score.\nTap to retry.'
  })
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: MAIN_CONTAINER_ID,
    containerName: MAIN_CONTAINER_NAME,
    content: text,
    contentOffset: 0,
    contentLength: 0,
  }))
}

if (result === 0) {
  const IGNORED_SYS_EVENTS = new Set<number>([
    OsEventTypeList.IMU_DATA_REPORT,
    OsEventTypeList.FOREGROUND_EXIT_EVENT,
    OsEventTypeList.SYSTEM_EXIT_EVENT,
    OsEventTypeList.ABNORMAL_EXIT_EVENT,
    OsEventTypeList.SCROLL_TOP_EVENT,
    OsEventTypeList.SCROLL_BOTTOM_EVENT,
  ])

  bridge.onEvenHubEvent((event) => {
    // Taps on the full-screen text container surface as a Sys_ItemEvent rather
    // than a Text_ItemEvent, and the CLICK_EVENT (0) type is sometimes omitted
    // entirely — treat any un-ignored sysEvent as "tap to refresh".
    const sys = event.sysEvent
    if (!sys) return
    if (sys.eventType !== undefined && IGNORED_SYS_EVENTS.has(sys.eventType)) return
    void refreshScore()
  })

  void refreshScore()
}
