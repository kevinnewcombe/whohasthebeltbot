# Who has the belt Bluesky bot
A Bluesky bot that posts updates about who has the NBA Championship belt to [whohasthebelt.bsky.social](https://bsky.app/profile/whohasthebelt.bsky.social).

Deploys from [Railway](https://railway.app/project/beda3e5a-d3fa-4faa-a030-dd1e18506caf/service/e0f1bd27-595e-455b-9f49-fc35396e7248?environmentId=af9f00cc-fe35-4d06-b394-c24974e49b14)

## How it works
The championship belt (not an actual thing) is based around the idea of the winners of last season's NBA finals starting the current season with a championship belt. They have it until they lose a game, at which point it goes to the team that beat them and so on.

Every hour a script runs and pulls a document from MongoDB containing data about the last time the belt was contested. The specific fields are
* `full_name` : the human-readable name of the defending team
* `number_of_games` : the number of games they played with the belt
* `last_update` : the last time we checked for new finished games, in `YYYY-MM-DD`
* `team_id` : the ID of the team used for making API calls

From here it makes a call to the Ball Don't Lie API, getting today's game (if one exists) for the defending team. If a game has finished since we last checked the API, it will post a message to Bluesky either saying that the streak has either been extended or changed hands.

The script runs every hour as set by `const job = new CronJob("0 * * * *", main);` in `index.ts`

## Installation
* Create a MongoDB collection named 'streak' inside a database named 'streak'. Add the following record as a starting point:
```
  {
    "full_name": "Oklahoma City Thunder",
    "last_update": "2025-10-01",
    "number_of_games": 0,
    "team_id": 21
  }
```
you'll likely need to run this script a few times in order to catch up to the current date.
* Duplicate `.env.example` as `.env` and populate the values with Bluesky credentials, a Ball Don't Lie API key, and a MongoDB connection string.
* Run `npm install`
* All the logic is in `index.ts`. Run `npm run dev` to start the dev server or `npm run start` to compile the script and run it.
