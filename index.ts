import { BskyAgent } from "@atproto/api";
import * as dotenv from "dotenv";
import { CronJob } from "cron";
import { BalldontlieAPI, NBAGame } from "@balldontlie/sdk";
import * as process from "process";
import * as mongoDB from "mongodb";

dotenv.config();

if (!process.env.BDL_API_KEY || !process.env.MONGODB_URI || !process.env.POST_TO_BLUESKY) {
  throw new Error('Missing environment variables.');
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
  const current_iso_date = new Date().toISOString();
  const end_date = current_iso_date.substring(0, current_iso_date.indexOf('T'));
  console.log(`Pulling data up to ${end_date}`);

  // Get the current streak from the database
  const client: mongoDB.MongoClient = new mongoDB.MongoClient(process.env.MONGODB_URI as string);
  try {
    await client.connect();
  } catch (error) {
    if (error instanceof Error) {
      console.error("Failed to connect to the database.", error.message);
    } else {
      console.error("Failed to connect to the database.", error);
    }
    return;
  }

  const db: mongoDB.Db = client.db('streak');
  const collection: mongoDB.Collection = db.collection('streak');
  let streak = await collection.findOne();
  if(!streak){
    return;
  }
  // Get the next 50 games for the current belt holder, starting on the day they won the belt
  // We're picking 50 because that's the max number of records returned via the API, and also
  // the NBA's longest win streak is 33 games so this should return a loss.

  let games: NBAGame[] = [];
  await api.nba
    .getGames({
      start_date: streak.start_date,
      end_date,
      per_page: 50,
      team_ids: [streak.team_id],
    })
    .then((response) => {
      games = response.data;
    })
    .catch((error) => console.error(error));
  if(!games.length){
    return;
  }

  // Filter out any future or in-progress games
  games = games.filter((game: NBAGame) => game.status === "Final");

  let wins_to_date = 0;
  let has_lost = false;
  let last_opponent:String = '';
  if(games.length){
    while(games.length && !has_lost ){
      const game = games.shift();
      let def:team|null = null;
      let opp:team|null = null; 
      if(!game){
        return;
      }

      if (game.home_team.full_name === streak.full_name) {
        def = { full_name: game.home_team.full_name, score: game.home_team_score, };
        opp = { full_name: game.visitor_team.full_name, score: game.visitor_team_score, team_id: game.visitor_team.id };
      } else {
        opp = { full_name: game.home_team.full_name, score: game.home_team_score, team_id: game.home_team.id };
        def = { full_name: game.visitor_team.full_name, score: game.visitor_team_score };
      }

      // only count wins where they've _defended_ the belt
      if(game.date !== streak.start_date){
        wins_to_date++;
      }

      if(opp.score > def.score){
        last_opponent = def.full_name;
        streak = {...streak, ...{
          "full_name":opp.full_name,
          "team_id":opp.team_id,
          "number_of_games":0,
          "start_date":game.date
        }};
        has_lost = true;
      } else {
        last_opponent = opp.full_name;
      }
    }
  }

  let msg = '';
  if(!has_lost && wins_to_date > streak.number_of_games){ 
    // if the streak has one more game than it did the last time we posted
    msg = `The ${streak.full_name} have beaten the ${last_opponent} to retain the belt (${(wins_to_date + 1)} game win streak).`;
    streak.number_of_games = wins_to_date;
  }else if(has_lost){
    // If the belt has changed hands
    msg = `The ${streak.full_name} have taken the belt from the ${last_opponent}.`;
  }

  if(msg){
    const result = await collection.updateOne({_id: streak._id}, { $set: streak });
    if(result.acknowledged){
      if(process.env.POST_TO_BLUESKY === "1"){
        console.log(`Message posted to Bluesky on ${end_date}: ${msg}`);
        await agent.login({ identifier: process.env.BLUESKY_USERNAME!, password: process.env.BLUESKY_PASSWORD!})
        await agent.post({
          text: msg
        });
      }else{
        console.log(`Message logged on ${end_date}: ${msg}`);
      }
    }else{
      console.log("Can't update the MongoDB database!", result);
    }
  }else{
    console.log('No updates posted');
  }

  console.log('\n');
  client.close();
}

main();

const job = new CronJob("0 * * * *", main); 

job.start();

