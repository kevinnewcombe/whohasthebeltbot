import { BskyAgent } from "@atproto/api";
import * as dotenv from "dotenv";
import { CronJob } from "cron";
import { BalldontlieAPI, NBAGame } from "@balldontlie/sdk";
import * as process from "process";
import * as mongoDB from "mongodb";

dotenv.config();

if (
  !process.env.BDL_API_KEY ||
  !process.env.MONGODB_URI ||
  !process.env.POST_TO_BLUESKY
) {
  throw new Error("Missing environment variables.");
}

interface team {
  full_name: String;
  team_id?: Number;
  score: Number;
}

// Ball Don't Lie API. Use this to grab the results of games
const api = new BalldontlieAPI({ apiKey: process.env.BDL_API_KEY });

// Bluesky API
const agent = new BskyAgent({
  service: "https://bsky.social",
});

async function main() {
  console.log(`\n\n---------\n\n`);
  const iso_date = new Date().toISOString();
  const date = iso_date.substring(0, iso_date.indexOf('T'));

  /**
   * Get the current streak from the database
   */
  const client: mongoDB.MongoClient = new mongoDB.MongoClient(
    process.env.MONGODB_URI as string
  );
  try {
    await client.connect();
  } catch (error) {
    if (error instanceof Error) {
      console.error("🚨 Failed to connect to the database.\n", error.message);
    } else {
      console.error("🚨 Failed to connect to the database.\n", error);
    }
    return;
  }

  const db: mongoDB.Db = client.db("streak");
  const collection: mongoDB.Collection = db.collection("streak");
  let streak = await collection.findOne();
  if (!streak) {
    console.error("🚨 Streak not found");
    return;
  }

  console.log(`Pulling games for ${date}`);
  if (streak.last_update == date) {
    console.log("No more games today");
    return;
  }

  /**
   * Get the next game that we _haven't_ recorded
   */
  let games: NBAGame[] = [];
  try {
     const data = await api.nba.getGames({
      start_date: date,
      end_date: date,
      per_page: 1,
      team_ids: [streak.team_id],
    });
    games = data.data;
  }catch(error){
    console.error('🚨', error);
    return;
  };

  if (!games.length) {
    console.log(`There are no ${streak.full_name} games today`);
    if (streak) {
      await collection.updateOne({ _id: streak._id }, { $set: { 'last_update': date }});
    }
    return;
  }

  // Filter out any in-progress games
  games = games.filter((game: NBAGame) => game.status === "Final");
  if (!games.length) {
    // If today's game is still in progress, exit
    console.log("There are unfinished games today");
    return;
  }  // Otherwise, today's game has ended but hasn't been counted, continue

  const game = games[0];

  let def: team | null = null;
  let opp: team | null = null;
  if (game.home_team.full_name === streak.full_name) {
    def = { full_name: game.home_team.full_name, score: game.home_team_score };
    opp = {
      full_name: game.visitor_team.full_name,
      score: game.visitor_team_score,
      team_id: game.visitor_team.id,
    };
  } else {
    opp = {
      full_name: game.home_team.full_name,
      score: game.home_team_score,
      team_id: game.home_team.id,
    };
    def = {
      full_name: game.visitor_team.full_name,
      score: game.visitor_team_score,
    };
  }
  let has_lost = false;
  if (opp.score > def.score) {
    has_lost = true;
    streak = {
      ...streak,
      full_name: opp.full_name,
      team_id: opp.team_id,
      number_of_games: 0
    };
  } else {
    streak = {
      ...streak,
      number_of_games: streak.number_of_games + 1,
    };
  }

  streak = {
    ...streak,
    last_update: date
  };

  const msg = (has_lost) ? `The ${streak.full_name} have taken the belt from the ${def.full_name}.` : `The ${streak.full_name} have beaten the ${opp.full_name} to retain the belt (${streak.number_of_games} game win streak).`;

  const result = await collection.updateOne(
    { _id: streak._id },
    { $set: streak }
  );
  if (result.acknowledged) {
    if (process.env.POST_TO_BLUESKY === "1") {
      console.log(`Message posted to Bluesky on ${date}: ${msg}`);
      await agent.login({
        identifier: process.env.BLUESKY_USERNAME!,
        password: process.env.BLUESKY_PASSWORD!,
      });
      await agent.post({
        text: msg,
      });
    } else {
      console.log(`Message logged on ${date}: ${msg}`);
    }
  } else {
    console.log("🚨 Can't update the MongoDB database\n", result);
  }
  client.close();
}


main();

const job = new CronJob("0 * * * *", main);

job.start();
