<div align="center">

# ACE Better Delta Bar

**A delta bar for the HUD of Assetto Corsa EVO that shows whether you are gaining or losing time right now.**<br>

[![Latest release](https://img.shields.io/github/v/release/dreasgrech/ACEBetterDeltaBar?style=flat-square&label=download&color=0a7)](../../releases/latest) [![Needs](https://img.shields.io/badge/needs-ACE_UI_App_Loader-informational?style=flat-square)](https://github.com/dreasgrech/ACEUIAppLoader)

</div>


<p align="center">
<img width="1098" height="94" alt="compact_A_nat_50_96" src="https://github.com/user-attachments/assets/8e760704-70a7-414d-bc93-24cf0f78bc19" />
</p>


The bar shows where your lap stands against the reference. The number's colour shows which way it is heading: green while you are gaining, red while you are losing, white while it holds. The game's own bar colours both by the lap as a whole, so a lap that is up but losing time in every corner stays green.

<img width="2560" height="1440" alt="20DC2E~1" src="https://github.com/user-attachments/assets/b9511b66-c29c-46fa-ae6b-f0df61f29e2d" />


Under the bar sit your session optimal, session best and predicted lap. The compact layout is a thin bar with the number in a tag that follows the end of the fill. The full layout can add a trace of the delta across the lap. Drag it anywhere on the HUD and it stays there.

<p align="center">
<img width="1212" height="258" alt="delta3_H_nat_50_96" src="https://github.com/user-attachments/assets/0881b8be-0a9a-4bfc-9377-6a47393c886d" />
</p>

---

## Installing the ACEBetterDeltaBar app

> [!WARNING]
> This is an app for the [ACE UI App Loader](https://github.com/dreasgrech/ACEUIAppLoader) mod so that needs to be installed (a single file) as well, version 0.26.0 or newer.

<table>
<tr><td width="40" align="center"><h3>1</h3></td><td>

Download the **`ACEBetterDeltaBar-….zip`** from the [latest release](../../releases/latest) and open it. Inside are two folders, `mods` and `Video`.

</td></tr>
<tr><td align="center"><h3>2</h3></td><td>

Press <kbd>Win</kbd> + <kbd>R</kbd>, paste this in, press <kbd>Enter</kbd>:

```
%USERPROFILE%\Saved Games\ACE
```

</td></tr>
<tr><td align="center"><h3>3</h3></td><td>

Drag **both** folders out of the zip into that window. If Windows asks, choose to **merge**. Nothing to run.

</td></tr>
</table>

In the car, move your mouse to the right edge of the screen. The delta bar is listed in the app drawer with its own switch and an **OPTIONS** button.

> [!TIP]
> Switch the game's own delta bar off, or you have two: **Escape -> Settings -> Gameplay / HUD -> HUD -> Delta Timer → Off**.

<p align="center">
<img width="2560" height="1440" alt="20EDF4~1" src="https://github.com/user-attachments/assets/c873a23f-9d15-4b50-a887-deba9318c956" />
</p>

---

## Reading it

| | |
|---|---|
| **The bar** | The lap's delta. It grows **right and green** when you are ahead of the reference and **left and red** when you are behind, like the game's own bar. By default a full bar is one second. |
| **The number** | The same delta as a figure: `-0.235` gained, `+0.235` lost. Its colour is the trend over the last second: green gaining, red losing, white holding. |
| **The chevrons** | Point the way the end of the bar is moving. They brighten when the trend is strong. |
| **SESSION OPTIMAL** | Your best sectors of the session, added up. |
| **SESSION BEST** | Your best lap of the session. |
| **PREDICTED LAP** | Where this lap is heading. Green when it beats your best by 20 ms or more, red when it trails it by 20 ms or more. |
| **LAST LAP** | Your last lap. Off by default. |
| **The lap trace** | Off by default. The delta across the lap so far: above the line where you gained, below where you lost. It clears at the line. |
| **INVALID** | A red tag when the game invalidates your lap, with its reason when it gives one, as in INVALID · TRACK LIMITS. In a race the reason comes a few seconds after the cut. |
| **PIT LANE**, **OUTLAP** | A quiet grey tag on a lap that doesn't count but wasn't cut: PIT LANE in the pit lane, OUTLAP for the rest of that lap. |
| **vs Name** | The driver the game compares you to, when it names one. |

With no reference lap yet, a line above the bar counts the lap you are on ("no reference yet · lap 0:34.2"), so you can see it is working. The reference is the game's own, so it changes when the stock bar's does.

<p align="center">
<img width="1176" height="126" alt="image" src="https://github.com/user-attachments/assets/28c8e8cd-b2c1-41d5-bd29-d8112531b59d" />
</p>

<p align="center">
<img width="1296" height="283" alt="image" src="https://github.com/user-attachments/assets/5b1da4e5-c620-4dfd-9c19-8128ba14b724" />
</p>



---

## Options

**OPTIONS** in the app drawer opens the settings; with ACE UI App Loader 0.27.0 or newer, so does a right-click on the bar. Point at a setting and a line at the foot of the window says what it does. Everything you change is kept, through the HUD reload and a restart. Click a section header to fold it. Defaults in bold.

<p align="center">
<img width="782" height="526" alt="image" src="https://github.com/user-attachments/assets/c4445eca-0d39-4944-ae6d-fcd206bff457" />
</p>

**Layout**
- *Layout*: **full** or compact.
- *Width*: narrow, **normal** or wide.
- *Faster side*: the way the bar grows for time gained: **right**, like the game's bar, or left, like iRacing's.
- *Bar range*: the delta that fills the bar: 0.5 s, **1 s**, 2 s or 5 s.
- *Decimals*: 2 or **3**.
- *Panel scale*: 0.6 to 2.0 in steps of 0.1, default **1.0**.

**Colour**
- *Number*: **trend**, overall (the game's rule: green while the lap is up) or white.
- *Bar*: **overall** or trend.
- *Trend window*: how far back the trend looks: 0.5 s, **1 s** or 2 s.
- *Trend sensitivity*: fine, **normal** or coarse.

**Show**
- *Trend chevrons* and *Lap tags*: **on**. *Hide until a reference lap*: **off**.
- Full layout: *Session optimal*, *Session best* and *Predicted lap* **on**; *Last lap* and *Lap trace* **off**.
- Compact layout: *Figure follows the fill*, **on**. Off keeps the tag centred.

**Look** (folded by default)
- *Background*: **dark**, light or none.
- *Attract mode*, **off**: a scripted lap, for recording without driving.
- *Demo tag*, **off**, shown while attract mode is on: the tag the scripted lap shows, to record it without cutting a lap: INVALID with any of the game's reasons, plain INVALID, OUTLAP or PIT LANE. Click it to go through them.

**Reset to defaults** puts every value back.

---

## If something isn't right

<details>
<summary><b>It isn't in the app drawer</b></summary><br>

1. **The loader isn't installed**, or its drawer doesn't appear at all. Start with the [loader's own help](https://github.com/dreasgrech/ACEUIAppLoader#if-something-isnt-right).
2. **The loader is older than 0.26.0.** Update it from its [latest release](https://github.com/dreasgrech/ACEUIAppLoader/releases/latest).
3. **Only one of the two folders was copied.** The app needs both: the folder under `mods` and the small file under `Video`. That file must stay completely empty.

</details>

<details>
<summary><b>It says "no reference lap"</b></summary><br>

The game has no lap to compare against yet. Drive a full lap first.

</details>

<details>
<summary><b>The lap trace stays empty</b></summary><br>

The trace needs the car's position along the lap, which the game reports in most modes. If it never fills, switch *Lap trace* off and open an [issue](../../issues) saying which mode and track you were in.

</details>

<details>
<summary><b>Anything else</b></summary><br>

Open an [issue](../../issues) and say what you saw. If you can, attach the newest file from `%USERPROFILE%\Saved Games\ACE\Logs`.

</details>

---

## Uninstalling

Delete the folder `mods\uiresources\ACEUIAppLoader\betterdeltabar` and the file `Video\ACEUIAppLoader-betterdeltabar.settingspreset`, both under `Saved Games\ACE`. Your settings stay in the game's UI settings file, where the game ignores them.

---

<div align="center">
<sub>Better Delta Bar 0.2.0 · needs ACE UI App Loader 0.26.0 or newer</sub>
</div>
