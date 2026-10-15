# elkz now playing

A Spotify "now playing" overlay for OBS, in the elkz style. A small server on your VPS stays signed in to Spotify and pushes the current track to the overlay as it changes.

- Album art, title, artist, a progress bar and time left
- Accent colour taken from the album art (or always elkz orange)
- The accent wipes across the card when the track changes
- Long titles scroll back and forth
- Hides itself when you pause (or stays and says "Paused")
- Wide card or tall layout, art on the left or right
- Only asks Spotify while an overlay is open
- No dependencies: just Node 18 or newer

## 1. Make a Spotify app

1. Go to <https://developer.spotify.com/dashboard> and click **Create app**. Spotify needs the app owner to have **Premium**.
2. Name it anything (e.g. "elkz overlay").
3. **Redirect URI**: your overlay's address + `/callback`, e.g. `https://music.example.com/callback`. It must be `https`.
4. Tick **Web API**, agree, save.
5. Open **Settings** and copy the **Client ID** and **Client secret**.
6. Under **User Management**, add the email of the Spotify account you stream from (if it isn't the account that made the app).

## 2. Put it on the VPS

First point a subdomain (e.g. `music.notelkz.net`) at the VPS: add an **A record** at your DNS provider with the VPS's IP address.

```bash
# on the VPS
git clone https://github.com/YOU/elkz-spotify-overlay.git
cd elkz-spotify-overlay
bash deploy/setup.sh
```

The setup script asks for the domain and your Spotify Client ID and secret, then:

- writes `.env` (with a random setup password)
- installs and starts the `elkz-spotify` service
- adds the nginx site and gets an HTTPS certificate with certbot

It needs Node 18+, nginx and certbot. Run it again any time to change the domain or keys; press Enter to keep a current value.

## 3. Sign in to Spotify (once)

Open `https://music.example.com/login`, type your `SETUP_PASSWORD`, and approve on Spotify. The sign-in is saved in `data/spotify-token.json` and renewed automatically, so you won't need to do this again unless you remove the app's access in your Spotify account settings.

## 4. Add it to OBS

Open `https://music.example.com/setup`, pick the look, and copy the URL.

In OBS: **Sources → + → Browser**, paste the URL, then:

- Size **1000 × 260** for the wide card, **500 × 760** for tall. It scales to the width you give it.
- Untick **Shutdown source when not visible**.

`https://music.example.com/overlay?demo=1` shows made-up tracks, handy for lining it up before Spotify is set up.

### URL options

| Option | Values | Default |
| --- | --- | --- |
| `layout` | `card`, `tall` | `card` |
| `art` | `left`, `right` | `left` |
| `accent` | `art`, `brand` | `art` |
| `hide` | seconds paused before hiding, `0` = never hide | `10` |
| `bg` | `solid`, `none` | `solid` |
| `time` | `1`, `0` | `1` |
| `demo` | `1` | off |
| `server` | the VPS address, only if the overlay page is hosted elsewhere | same site |

## Hosting the overlay page on GitHub Pages (optional)

The VPS has to run the server either way, because Spotify sign-in needs a secret that must not be in a public page. If you'd still like the overlay page itself on GitHub Pages, publish the `public` folder and add `server=` to the URL:

`https://you.github.io/elkz-spotify-overlay/overlay.html?server=https://music.example.com`

## Updating

```bash
cd elkz-spotify-overlay && git pull && sudo systemctl restart elkz-spotify
```

## Privacy

`/api/now-playing` and the overlay show what you're listening to, which is on stream anyway. Nothing else from your Spotify account is exposed. The sign-in file (`data/`) and `.env` are in `.gitignore`; never commit them.
