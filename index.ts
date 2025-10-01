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

type Team = {
  full_name: String;
  team_id?: Number;
  score: Number;
}

type TeamLocation = 'home_team' | 'visitor_team';

// Ball Don't Lie API. Use this to grab the results of games
const api = new BalldontlieAPI({ apiKey: process.env.BDL_API_KEY });

// Bluesky API
const agent = new BskyAgent({
  service: "https://bsky.social",
});

async function main() {
  console.log(`\n---------\n`);
  const iso_date = new Date().toISOString();
  const today = iso_date.substring(0, iso_date.indexOf('T'));

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
    client.close();
    return;
  }

  if (streak.last_update == today) {
    console.log("No more games today");
    client.close();
    return;
  }

  let start_date:string|Date = new Date(streak.last_update); // Get the day after the last time the streak was updated
  start_date = new Date(start_date.getTime() + 24*60*60*1000).toISOString();
  start_date =  start_date.substring(0, start_date.indexOf('T'));

  console.log(`Last update: ${streak.last_update}\nPulling games from ${start_date} to ${today}\n`);

  // Get all the regular season games for the current belt holder between the day after the streak was last updated and today
  let games: NBAGame[] = [];
  try {
     const data = await api.nba.getGames({
      start_date,
      end_date: today,
      postseason: false,
      team_ids: [streak.team_id],
    });
    games = data.data;
  }catch(error){
    console.error('🚨', error);
    client.close();
    return;
  };

  if (!games.length) {
    console.log(`There are no unfinished ${streak.full_name} games.`);
    client.close();
    return;
  }

  // Filter out any games that haven't finished and exit if that leaves us with nothing
  games = games.filter((game: NBAGame) => game.status === "Final");
  if (!games.length) {
    console.log("There are unfinished games today");
    client.close();
    return;
  }  // Otherwise, today's game has ended but hasn't been counted, continue


  const game = games[0]; // Get the first unfinished game

  // Get the belt holder and challenger names
  const defTeamLocation:TeamLocation = (game.home_team.full_name === streak.full_name) ? 'home_team' : 'visitor_team';
  const oppTeamLocation:TeamLocation = (game.home_team.full_name === streak.full_name) ? 'visitor_team' : 'home_team';

  const def:Team = { 
    full_name: game[defTeamLocation].full_name, 
    score: game[`${defTeamLocation}_score`] 
  };

  const opp:Team = { 
    full_name: game[oppTeamLocation].full_name, 
    score: game[`${oppTeamLocation}_score`], 
    team_id: game[oppTeamLocation].id  
  };


  if (opp.score > def.score) {
    // The belt holder lost, start a new streak
    streak = {
      ...streak,
      full_name: opp.full_name,
      team_id: opp.team_id,
      number_of_games: 0
    };
  } else {
    // The streak has been extended
    streak = {
      ...streak,
      number_of_games: streak.number_of_games + 1,
    };
  }

  streak = {
    ...streak,
    last_update: game.date
  };

  const msg = (opp.score > def.score) ? `The ${streak.full_name} have taken the belt from the ${def.full_name}.` : `The ${streak.full_name} have beaten the ${opp.full_name} to retain the belt (${streak.number_of_games} game${streak.number_of_games >1 ? 's' : ''}).`;

  const result = await collection.updateOne(
    { _id: streak._id },
    { $set: streak }
  );
  if (result.acknowledged) {
    if (process.env.POST_TO_BLUESKY === "1") {
      console.log(`Message posted to Bluesky for ${game.date}: ${msg}`);
      await agent.login({
        identifier: process.env.BLUESKY_USERNAME!,
        password: process.env.BLUESKY_PASSWORD!,
      });
      await agent.post({
        text: msg,
      });
    } else {
      console.log(`Message logged for ${game.date}: ${msg}`);
    }
  } else {
    console.log("🚨 Can't update the MongoDB database\n", result);
  }
  /* */
  client.close();
}

main();
const job = new CronJob("0 * * * *", main);
job.start();

