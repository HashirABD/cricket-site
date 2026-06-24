export default async function handler(req, res) {
  const API_KEY = process.env.CRIC_API_KEY;
  const url = `https://api.cricapi.com/v1/currentMatches?apikey=${API_KEY}&offset=0`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch matches" });
  }
}
