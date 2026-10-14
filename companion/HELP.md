# Middleman Software - BreakTime

This module controls Middleman Software's BreakTime, version 2.0 or later. For BreakTime 1.x, use version 1.0.3 of this module. For more information, visit <a href="https://middleman.tv" target="_new">https://middleman.tv</a>.

## Compatibility

| Module | BreakTime     |
| ------ | ------------- |
| 1.x    | 1.1           |
| 2.x    | 2.0 and later |

- Module 2.x works only with BreakTime 2.0 or later. For BreakTime 1.x, use version 1.0.3 of this module.
- Module 2.x needs Companion 4.1 or later.
- Module 2.x is published as a prerelease while BreakTime 2.0 is in beta.
- Tested with BreakTime 2.0.222-beta and Companion 5.1.0.
- If the module finds BreakTime 1.x, the connection shows **Bad Config** with "BreakTime 2.0 or later required, found ...". It checks again every 60 seconds.

## Configuration

Host and Port are always shown. The other settings appear when **Show Advanced Settings** is on.

| Field                  | Notes                                                                                                                                                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host                   | IP address or hostname of the BreakTime server.                                                                                                                                                                                                                                     |
| Port                   | BreakTime's web port, default 5165.                                                                                                                                                                                                                                                 |
| Show Advanced Settings | Shows the settings below it. Turning it off only hides them: they keep their values and stay in effect, so a hidden API key is still used.                                                                                                                                          |
| API Key                | Only needed when BreakTime security is on.                                                                                                                                                                                                                                          |
| Running Event Slots    | How many running events get their own variables and Running Slot buttons: 1 to 32, default 4. An event keeps its slot until it ends (see Running slots).                                                                                                                            |
| Verbose Logging        | Adds detailed lines to the log: each request sent to BreakTime with its result and how long it took, each playlist change, and component status changes between Healthy and Warning. Shows the Log Raw BreakTime Data option. For troubleshooting only; turn it off for normal use. |
| Log Raw BreakTime Data | Writes every update from BreakTime to the log, about once a second. For troubleshooting only. Appears once Verbose Logging is on.                                                                                                                                                   |

Changing Show Advanced Settings, Verbose Logging, Log Raw BreakTime Data, Running Event Slots or the connection label never drops a working connection. While the module is waiting to retry (after a connection failure, an authentication failure or an unsupported BreakTime), saving the configuration retries at once. Changing the host, port or API key starts a new connection at once. After a host or port change, event lists show "Loading Events..." until the new server answers.

### API key

- The module detects BreakTime security by itself. With security off, leave the key blank.
- With security on, create an API key in BreakTime and paste it into API Key, under Show Advanced Settings. Revoke it in BreakTime when it is no longer needed.
- **Companion includes secrets in configuration exports by default.** Turn off "Include secrets" before you share an export, or the API key goes with it. If an export that contains the key leaks, revoke the key in BreakTime and create a new one.

## Armed and Running

These match the BreakTime UI.

- **Armed** is the one event BreakTime fires next. It moves on after every Start: BreakTime arms the entry after the started event in playlist order, wrapping to the top, even if that entry is already running.
- **Running** events are the events on air now. Several can run at once.

Module 1.x called the armed event "Selected", which hid the fact that it moves. Stored action, feedback and variable IDs are unchanged, so existing buttons keep working; only the names say "Armed" now.

## Running slots

Each running event gets a numbered slot, with its own variables and a Running Slot button. Running Event Slots, under Show Advanced Settings, sets how many slots there are.

- An event takes the lowest free slot when it starts and keeps it until it ends. When an event ends, its slot goes blank and every other event stays where it is, so a button showing slot 2 keeps showing the same event.
- If more events are running than there are slots, the extra ones have no slot: they still count in `running_events_count` and appear in `running_events_json`, and take the next slot that frees up, oldest first.
- When the module starts (including after a Companion restart or re-enabling the connection) and after a host or port change, the events already running get slots oldest first.
- While the module is not connected the slots are blank. When it reconnects to the same BreakTime, an event that is still running gets its old slot back.
- Lowering Running Event Slots frees the slots above the new number. Raising it gives a slot straight away to running events that had none. Events in the remaining slots keep them.
- The **latest running** variables always show the newest running event: the one End Running Event ends with its default "Latest running" target. The END buttons in the presets show it, so they always name the event they will end.

## Starting events

There are two Start actions:

- **Start Event** starts the armed event (the default, "Armed event (as shown in Companion)") or a specific event. It fires exactly the event the module shows.
    - It refuses an event that is already running ("Event is already running") and sends nothing.
    - With the armed default, it refuses while the module is not connected ("Not connected to BreakTime"), because the armed event it last saw may be out of date. A specific event is still sent.
    - "Only when no event is running" (default off) refuses the start while any event is on air ("Another event is already running") and while the module is not connected ("Not connected to BreakTime").
- **Start Armed Event** asks BreakTime to start whatever BreakTime has armed. It works even while the module is disconnected, because BreakTime reads its own arm.
    - Each Start moves the arm to the next playlist entry, as long as the start was actually sent. If that entry is already running, a further Start Armed Event is refused with an Action Problem warning.
    - After "Not confirmed by BreakTime", check what is running before you press Start Armed again: pressing again starts the next event.

Every Start and End action has an **Immediate** checkbox (default off). It crashes out: it splices now, with no pre-roll or correction. Time Signal events have no crash-out.

## Ending events

End Running Event has a **Target**:

- **Latest running** (default): ends the event that started most recently, the one the latest running variables show.
- **All running**: ends every running event at once. One warning summarizes any refusals, for example "2 of 3 ends: ...".
- **Specific event**: ends the chosen event.

Latest and All are refused while the module is not connected ("Not connected to BreakTime"), because it cannot know what is running. Specific is still sent; BreakTime ignores it if that event is not running. Nothing is sent when no event is running ("No event is running") or the specific event is not running ("Event is not running").

## Pressing Start or End twice

A second Start press within half a second of a Start press that was sent is ignored: nothing is sent, the Event Related warning shows "Pressed again within 0.5 s", and the log shows `outcome=NotSent`. If a warning other than an Event Related one is already showing, such as BreakTime's answer to the first press, that warning stays on screen instead. End works the same way. Start Event and Start Armed Event share one half second, and every End Running Event target shares another, so an End right after a Start still acts.

- The half second counts from the last press that was sent. An ignored press does not extend it.
- Otherwise every press acts. A second Start of the armed event (Start Event with the armed default, or Start Armed Event) while an event is on air starts the next armed event, unless that event is already running. A second Start Event for a specific event that is now running is refused ("Event is already running"). A second End with the Latest running target ends the next latest running event.
- After each accepted Start or End the module asks BreakTime for an update at once, so the armed event, the running events and the END buttons show the change straight away.
- When the connection to BreakTime drops, or the host or port changes, the half second is cleared.

## Arming

- **Arm Next** and **Arm Previous** wrap around at both ends of the playlist. If the armed event is unknown (nothing armed, or the armed event was deleted), Arm Next arms the first event and Arm Previous the last.
- **Arm Event** arms the chosen event.
- Rapid presses are combined: at most one arm request is in flight, and presses made meanwhile send one request for their final target when it answers. Three quick Arm Next presses always end three events on, in order. Each press still writes its own log line.

## Duration

- Armed Duration +, Armed Duration - and Set Armed Duration change the **armed** event, only while it is **stopped** and only for **Count Down** events.
- BreakTime keeps every duration between a 6 second floor and a ceiling of 6553 seconds (Splice Insert) or 65535 seconds (Time Signal).
- Armed Duration + / - take whole seconds from 1 to 65535. Set Armed Duration takes the target duration and refuses a value outside the range for the event's message mode. Setting the duration it already has sends nothing.
- A fast second press counts from the first press's result, so pressing "1:30" twice lands on 90 seconds.
- The **Armed Duration Change Not Allowed** feedback is on whenever these actions would be refused: nothing is armed, the armed event counts up or is running, or Companion is not connected to BreakTime.
- Set Armed Duration refusals show as the Increase or Decrease Duration warning type, by direction (Event Related when the current duration or the target is not known).

**Running events:** An event's duration can't be changed once it has started. The START already signaled it downstream, and SCTE 35/104 provide no way to re-signal it. End the event early instead.

## Operator Panel

The **Operator Panel** preset category builds a button panel for an operator: pick the event, pick its duration, START, END.

Suggested layout:

- Top row: one event tile per playlist event, named after the event.
- Second row: the duration buttons **0:30**, **1:00**, **1:30**, **2:00** and **3:00**.
- Bottom row: **START**, **END**, **END ALL** and **Panel Status**.

Colors: **red** means on air, **amber** means armed and ready, **dark gray** means idle.

- **Event tiles** show the event's name and duration, with a live countdown (or elapsed time for Count Up) while on air. Pressing a tile arms that event. A tile whose event was deleted shows "(removed)". One tile preset exists per event, and the list updates when the playlist changes.
- **Duration buttons** set the armed event's duration. The current duration is green; the buttons are dimmed when the duration cannot change. The seconds field accepts variables, so a button can be retargeted without editing code.
- **START** names exactly what it will fire (armed event and duration), and is amber when that event is ready to start. While any event is on air, START keeps its text and gets a thin red frame; a press then starts the armed event, which you can choose with the event tiles. If the armed event is itself on air, START is dimmed and a press sends nothing ("Event is already running"). A second press within half a second is ignored.
- **END** is blank while nothing is on air; pressing it then sends nothing. While an event runs it turns red and shows the latest running event and its time; pressing it ends that event. A second press within half a second is ignored.
- **END ALL** appears only while two or more events run.
- **Panel Status** shows the current message: amber during any warning, red "STANDBY" on a paired standby instance.

Event tiles store the event ID. A JSON playlist import keeps event IDs; an XLS import creates new ones, so drag the event tiles again after an XLS import.

**Event names containing `$(` or `\n`:** event tiles show the name exactly as typed. Buttons that show the name through a variable, such as START, END, Running Slot and Armed Event Name, may show something else: Companion reads `$(...)` inside a variable as another variable, and a typed backslash followed by `n` or `r` as a line break (followed by `t`, as a tab). The variables themselves always hold the name as typed.

## Playlist imports

JSON imports keep event IDs, so buttons and tiles that name an event keep working. XLS imports create new event IDs: re-select the event in actions and feedbacks that name one, and drag the Operator Panel event tiles again.

## HA pairs

- Start and End work against either instance.
- An arm sent to the standby instance is normally replaced by the live instance's arm within about a second, except while an event involved is running. A duration change sent to the standby instance is not copied to the live instance. The module still sends both, then shows the Sent to HA Standby warning (unless BreakTime's answer raised a warning of its own).
- Start Armed Event on the standby instance starts that instance's armed event. If you change the arm and then press Start Armed Event, send both to the same instance, or use Start Event.
- Point Companion at the live instance. For redundancy, run one Companion per instance on separate hardware, as in BreakTime's HA commissioning checklist.
- The **HA Live**, **HA Standby**, **HA Link State** and **HA Ready to Send** feedbacks and the `ha_*` variables show the instance's HA state. An HA role alarm shows in `message`.

## Changes from 1.x

IDs are unchanged, but some values changed. Update triggers and expressions that compare them:

- `selected_name` with nothing armed is `No Event Armed` (was `No Event Selected`).
- `selected_time_ss` is `0`, not blank, when the time is zero (for example a stopped Count Up event). The duration variables `selected_duration_ss`, `selected_duration_mmss` and `selected_duration_hhmmss` are still blank at 0 seconds.
- The SCTE 104 and vMix status variables, `message` and `warning` are set even when nothing is armed.
- Status values can be `Disabled` or `Unknown` as well as `Connected` and `Disconnected`.
- SCTE 104 reads Connected when the SCTE 104 Client **or** the SCTE 104 Server is connected (1.x read only the client).
- `selected_status` can be `Unknown` (not connected).
- The Armed Event Status preset (Selected Event Status in 1.x) no longer has its red entry; it never fired in 1.x.

Display names that changed (IDs unchanged):

| Kind     | 1.x name                                                 | 2.x name                                                         |
| -------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| Config   | IP Address                                               | Host                                                             |
| Config   | Verbose Logging - Show Websocket Data                    | Log Raw BreakTime Data                                           |
| Action   | Start Selected Event                                     | Start Event                                                      |
| Action   | End Selected Event                                       | End Running Event (now ends the running event)                   |
| Action   | Select Next Event                                        | Arm Next (now wraps)                                             |
| Action   | Select Previous Event                                    | Arm Previous (now wraps)                                         |
| Action   | Select Event                                             | Arm Event                                                        |
| Action   | Increase Duration                                        | Armed Duration +                                                 |
| Action   | Decrease Duration                                        | Armed Duration -                                                 |
| Option   | Duration (Increase / Decrease Duration)                  | Seconds (Armed Duration + / -)                                   |
| Feedback | Selected Event is Running                                | Armed Event is Running                                           |
| Feedback | Selected Event is Stopped/Finished                       | Armed Event is Stopped                                           |
| Feedback | Selected Event Duration Mode                             | Armed Event Duration Mode                                        |
| Feedback | Increase/Decrease Not Allowed                            | Armed Duration Change Not Allowed                                |
| Feedback | SCTE-104 Injector Connected                              | SCTE 104 Injector Connected                                      |
| Feedback | SCTE-104 Injector Disconnected                           | SCTE 104 Injector Disconnected                                   |
| Variable | Selected Event Name                                      | Armed Event Name                                                 |
| Variable | Selected Event Status                                    | Armed Event Status                                               |
| Variable | Selected Event Duration (SS, MM:SS, HH:MM:SS)            | Armed Event Duration (Seconds, MM:SS, HH:MM:SS)                  |
| Variable | Selected Event Time Remaining/Elapsed (SS, ...)          | Armed Event Time Remaining/Elapsed (Seconds, ...)                |
| Variable | Selected Event Duration Mode                             | Armed Event Duration Mode                                        |
| Variable | SCTE 104 Injector Status Bool                            | SCTE 104 Injector Connected (True/False)                         |
| Variable | SCTE 104 Splice Event ID, SCTE 104 Segmentation Event ID | Last Started Splice Event ID, Last Started Segmentation Event ID |
| Variable | VMix Connectivity Status, VMix Connectivity Status Bool  | vMix Connectivity Status, vMix Connected (True/False)            |
| Variable | Temporary Warning Activated                              | Warning Showing (True/False)                                     |
| Option   | Warning Type: SCTE 104 Injector Status                   | Warning Type: SCTE 104 Disconnected                              |
| Option   | Warning Type: VMix Connectivity Status                   | Warning Type: vMix Disconnected                                  |
| Preset   | Start Selected Event                                     | Start Event                                                      |
| Preset   | End Selected Event                                       | End Running Event                                                |
| Preset   | Select Next Event                                        | Arm Next                                                         |
| Preset   | Select Previous Event                                    | Arm Previous                                                     |
| Preset   | Increase Duration 5 Seconds                              | Armed Duration +5s                                               |
| Preset   | Decrease Duration 5 Seconds                              | Armed Duration -5s                                               |
| Preset   | Selected Event Name                                      | Armed Event Name                                                 |
| Preset   | Selected Event Status                                    | Armed Event Status                                               |
| Preset   | Selected Event Duration                                  | Armed Event Duration                                             |
| Preset   | Selected Event Time Remaining/Elapsed                    | Armed Event Time Remaining/Elapsed                               |
| Preset   | Selected Event Duration Mode                             | Armed Event Duration Mode                                        |
| Preset   | SCTE 104 Injector Status Bool                            | SCTE 104 Injector Connected (True/False)                         |
| Preset   | VMix Connectivity Status, VMix Connectivity Status Bool  | vMix Connectivity Status, vMix Connected (True/False)            |

The two explanatory text blocks under the logging checkboxes on the config page are gone: each of the two fields has a tooltip in its place. Log Raw BreakTime Data now logs only while Verbose Logging is on, and appears only then. Both logging checkboxes are now under Show Advanced Settings. If Log Raw BreakTime Data was on and Verbose Logging was off, upgrading to 2.x turns Log Raw BreakTime Data off, so turning on Verbose Logging later does not also start logging every update from BreakTime.

Unchanged: the vMix Connected, vMix Disconnected and Temporary Warning feedbacks, the Event Related, Increase Duration Not Allowed and Decrease Duration Not Allowed warning types, and the Running Events Count, SCTE 104 Injector Status and Current Message variables and presets.

## Reference

### Actions

| Action             | Options                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start Event        | Event: "Armed event (as shown in Companion)" (default) or a playlist event. Immediate (default off). Only when no event is running (default off). |
| Start Armed Event  | Immediate (default off).                                                                                                                          |
| End Running Event  | Target: Latest running (default), All running, Specific event. Event (shown for Specific event). Immediate (default off).                         |
| Arm Next           | None. Wraps from last to first.                                                                                                                   |
| Arm Previous       | None. Wraps from first to last.                                                                                                                   |
| Arm Event          | Event.                                                                                                                                            |
| Armed Duration +   | Seconds (variables allowed, default 5): whole seconds to add, 1 to 65535.                                                                         |
| Armed Duration -   | Seconds (variables allowed, default 5): whole seconds to subtract, 1 to 65535.                                                                    |
| Set Armed Duration | Seconds (variables allowed, default 60): 6 to 6553 (Splice Insert) or 6 to 65535 (Time Signal).                                                   |

### Feedbacks

| Feedback                          | Options                                                                                | On when                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Armed Event is Running            | -                                                                                      | The armed event is running.                                                                                      |
| Armed Event is Stopped            | -                                                                                      | An event is armed and stopped.                                                                                   |
| Armed Event Duration Mode         | Mode: Count Up (default) or Count Down                                                 | The armed event uses that mode.                                                                                  |
| Armed Duration Change Not Allowed | -                                                                                      | Nothing is armed, the armed event counts up or is running, or Companion is not connected to BreakTime.           |
| Armed Duration Is                 | Seconds (variables allowed, default 60)                                                | The armed Count Down event has exactly that duration.                                                            |
| Event is Running                  | Target: Any event (default), Armed event, Specific event. Event (for Specific event).  | That event (or any event) is running.                                                                            |
| Running Slot Time Remaining Below | Slot (variables allowed, default 1, 1 to 32). Seconds (variables allowed, default 10). | The Count Down event in that running slot has less time left.                                                    |
| Running Event Count At Least      | Count (default 2)                                                                      | At least that many events are running.                                                                           |
| Event Tile                        | Event                                                                                  | Always (advanced feedback): styles the button as an event tile (see Operator Panel).                             |
| vMix Connected                    | -                                                                                      | vMix is connected.                                                                                               |
| vMix Disconnected                 | -                                                                                      | vMix is enabled in BreakTime but not connected.                                                                  |
| SCTE 104 Injector Connected       | -                                                                                      | The SCTE 104 Client or Server is connected.                                                                      |
| SCTE 104 Injector Disconnected    | -                                                                                      | SCTE 104 is enabled in BreakTime but neither the Client nor the Server is connected.                             |
| Component Status                  | Component (default Stream Injector). Status (default Unhealthy).                       | That component has that status.                                                                                  |
| HA Live                           | -                                                                                      | This instance is the live one. Also on for a BreakTime licensed as Primary that is not paired.                   |
| HA Standby                        | -                                                                                      | This instance is paired and is not the live one.                                                                 |
| HA Link State                     | State: Inactive (standalone), Connecting, Connected, Degraded (default)                | The link between the pair is in that state.                                                                      |
| HA Ready to Send                  | -                                                                                      | This instance is licensed, has an SCTE 35 PID set or the SDI Injector on, and has at least one output connected. |
| Temporary Warning                 | Warning Type (default Event Related), or Any warning                                   | A warning of that type is showing.                                                                               |

Warning types: **Event Related** (a local check refused the action and sent nothing: nothing armed, not connected, not running, invalid event, empty playlist, Start or End pressed again within half a second), **Increase Duration Not Allowed** and **Decrease Duration Not Allowed** (any duration refusal), **Action Problem** (BreakTime refused the request, accepted it with "Nothing sent from this instance", or did not confirm it), **Authentication** (HTTP 401 or 403), **Unsupported BreakTime Version** (not BreakTime 2.0, or this BreakTime version does not support the action), **Request Failed** (network error, other server error, a duration request that got no answer, or an unexpected reply), **Sent to HA Standby** (an arm or duration change sent to the standby instance), **BreakTime Warning** (a warning broadcast by BreakTime), **SCTE 104 Disconnected** and **vMix Disconnected** (a connected output disconnected). Local checks show for 2 seconds, everything else for 5.

### Component status

Each BreakTime component reads `Healthy`, `Warning`, `Unhealthy`, `Disabled` or `Unknown` (not reported by BreakTime, or not connected). Components: Stream Injector, SDI Injector, SCTE 104 Client, SCTE 104 Server (`Warning` means listening with no clients), Captions, Zixi, vMix, AvailX TX and Stream Health (absent, so `Unknown`, while the Stream Injector is disabled or disconnected).

The 1.x status variables use their own buckets:

- **SCTE 104**: `Connected` when the Client **or** the Server is Healthy, `Disabled` when both are Disabled, `Unknown` while not connected, otherwise `Disconnected`.
- **vMix**: `Connected` when Healthy, `Disabled` when Disabled, `Unknown` while not connected, otherwise `Disconnected`.

### Variables

`N` is a running slot from 1 to Running Event Slots. An event keeps its slot until it ends (see Running slots).

| Variable                                                                           | Value                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `selected_name`                                                                    | Armed event name, or `No Event Armed`.                                                                                                                                                                                                                                                                                                                      |
| `selected_status`                                                                  | `Running`, `Stopped` or `Unknown` (not connected); blank when nothing is armed.                                                                                                                                                                                                                                                                             |
| `selected_duration_mode`                                                           | `Count Down` or `Count Up`.                                                                                                                                                                                                                                                                                                                                 |
| `selected_duration_ss`, `selected_duration_mmss`, `selected_duration_hhmmss`       | Armed event duration; blank at 0 seconds.                                                                                                                                                                                                                                                                                                                   |
| `selected_time_ss`, `selected_time_mmss`, `selected_time_hhmmss`                   | Count Down: time remaining while running, the duration when stopped. Count Up: time elapsed while running, 0 when stopped.                                                                                                                                                                                                                                  |
| `running_events_count`                                                             | Number of running events; blank while not connected.                                                                                                                                                                                                                                                                                                        |
| `running_events_json`                                                              | Every running event, newest first, as JSON: `id`, `name`, `durationMode`, `durationSeconds`, `elapsedSeconds`, `remainingSeconds` (null for Count Up), `messageMode`, `spliceEventId`, `segmentationEventId` (null when they do not apply), `slot` (the event's slot number, null while it has no slot). `[]` when nothing runs; blank while not connected. |
| `running_latest_name`, `running_latest_id`                                         | Name and ID of the latest running event: the newest one, which End Running Event ends with the Latest running target. Blank when nothing runs.                                                                                                                                                                                                              |
| `running_latest_duration_mode`                                                     | `Count Down` or `Count Up`.                                                                                                                                                                                                                                                                                                                                 |
| `running_latest_time_ss`, `running_latest_time_mmss`, `running_latest_time_hhmmss` | Time remaining (Count Down) or elapsed (Count Up) of the latest running event.                                                                                                                                                                                                                                                                              |
| `running_N_name`, `running_N_id`                                                   | Name and ID of the event in slot N.                                                                                                                                                                                                                                                                                                                         |
| `running_N_duration_mode`                                                          | `Count Down` or `Count Up`.                                                                                                                                                                                                                                                                                                                                 |
| `running_N_time_ss`, `running_N_time_mmss`, `running_N_time_hhmmss`                | Time remaining (Count Down) or elapsed (Count Up).                                                                                                                                                                                                                                                                                                          |
| `running_N_duration_ss`, `running_N_duration_mmss`, `running_N_duration_hhmmss`    | Duration; blank at 0 seconds.                                                                                                                                                                                                                                                                                                                               |
| `running_N_splice_event_id`                                                        | SCTE splice event ID (Splice Insert only).                                                                                                                                                                                                                                                                                                                  |
| `running_N_segmentation_event_id`                                                  | SCTE segmentation event ID (Time Signal only).                                                                                                                                                                                                                                                                                                              |
| `scte104_injector_status`, `scte104_injector_status_bool`                          | SCTE 104 bucket (see above); `scte104_injector_status_bool` is `True` only when Connected.                                                                                                                                                                                                                                                                  |
| `scte104_splice_event_id`                                                          | Splice event ID of the last event started on this instance (Splice Insert only); blank until an event has started here since BreakTime started.                                                                                                                                                                                                             |
| `scte104_segmentation_event_id`                                                    | Segmentation event ID of the last event started on this instance (Time Signal only); blank until an event has started here since BreakTime started.                                                                                                                                                                                                         |
| `vmix_status`, `vmix_status_bool`                                                  | vMix bucket (see above); `vmix_status_bool` is `True` only when Connected.                                                                                                                                                                                                                                                                                  |
| `component_<slug>`                                                                 | Component status. Slugs: `stream_injector`, `sdi_injector`, `scte104_client`, `scte104_server`, `captions`, `zixi`, `vmix`, `availx_tx`, `stream_health`.                                                                                                                                                                                                   |
| `component_<slug>_detail`                                                          | BreakTime's status detail for that component.                                                                                                                                                                                                                                                                                                               |
| `ha_role`                                                                          | `Primary`, `Secondary` or `Undefined` (unlicensed).                                                                                                                                                                                                                                                                                                         |
| `ha_acting`, `ha_emit_ready`                                                       | `True` or `False`.                                                                                                                                                                                                                                                                                                                                          |
| `ha_link_state`                                                                    | `Inactive` (standalone), `Connecting`, `Connected` or `Degraded`.                                                                                                                                                                                                                                                                                           |
| `message`                                                                          | The active warning, otherwise the HA role alarm, otherwise blank.                                                                                                                                                                                                                                                                                           |
| `warning`                                                                          | `True` while a warning shows.                                                                                                                                                                                                                                                                                                                               |
| `breaktime_version`                                                                | BreakTime version, for example `2.0.222-beta+e8d7026389`.                                                                                                                                                                                                                                                                                                   |
| `breaktime_security`                                                               | `On` or `Off`; blank until known. Read when the module connects: if BreakTime security is turned on or off while the module stays connected, this updates at the next reconnect, because BreakTime keeps open connections when security changes.                                                                                                            |

Empty running slots are blank, and so are the latest running variables when nothing runs. All of them are blank while not connected. `ha_role`, `ha_acting`, `ha_link_state` and `ha_emit_ready` are blank while not connected.

These variables are numbers (or blank when there is no value): `selected_duration_ss`, `selected_time_ss`, `running_events_count`, `running_latest_time_ss`, `scte104_splice_event_id`, `scte104_segmentation_event_id`, and for each slot N `running_N_time_ss`, `running_N_duration_ss`, `running_N_splice_event_id` and `running_N_segmentation_event_id`. Every other variable is text; `running_events_json` is JSON text. Button text that shows an event tile uses Companion's `\n` line break.

### Presets

- **Event Controls**: Start Event, Start Armed Event, End Running Event, End Running (Red While On Air), End Running (Immediate), Arm Next, Arm Previous. While an event runs, the two End Running buttons turn red and show the latest running event and its time.
- **Duration Controls**: Armed Duration +5s, Armed Duration -5s.
- **Running**: one Running Slot N button per slot (red under 10 seconds left), Running Status.
- **Info/Variables**: armed event name, status, duration, time and mode; SCTE 104 and vMix status; current message; running events count.
- **Operator Panel**: see above.

## Troubleshooting

The connection status and the log tell you what is wrong. Log lines below are examples.

### Bad Config

- "Host and port are required", "Host is required", "Port is required", "Host is not a valid hostname or IP address", "Port must be a number from 1 to 65535" or "API key contains invalid characters": fix the config (API Key is under Show Advanced Settings). Nothing is retried until you do.
  `config: invalid host=10.1.4.12:5165 status=bad_config reason="API key contains invalid characters"`
- "BreakTime 2.0 or later required, found ... For BreakTime 1.x, use module v1.0.3.": the server is BreakTime 1.x. Upgrade BreakTime or use module v1.0.3. Checked again every 60 seconds.
  `conn: unsupported host=10.1.4.12:5165 status=bad_config reason="BreakTime 2.0 or later required, found BreakTime 1.x at 10.1.4.12:5165. For BreakTime 1.x, use module v1.0.3."`
- "Not a BreakTime 2.0 server": the host answered, but not as BreakTime 2.0. Check the host and port.

### Authentication Failure

- "API key required: BreakTime security is on. Enter it under Show Advanced Settings.": security is on and no key is set. Create a key in BreakTime and enter it in API Key, under Show Advanced Settings.
  `conn: auth failed host=10.1.4.12:5165 status=authentication_failure reason="API key required: BreakTime security is on. Enter it under Show Advanced Settings."`
- "BreakTime rejected the API key": the key is wrong or was revoked. Create a new key in BreakTime and enter it in API Key, under Show Advanced Settings.
  `conn: auth failed host=10.1.4.12:5165 status=authentication_failure http=401 reason="BreakTime rejected the API key"`

The module retries every 5 seconds and logs the failure once. Saving a new key retries at once.

### Connecting

- "BreakTime is starting": BreakTime is up but has not finished starting. The module waits and connects when it is ready.
  `conn: starting host=10.1.4.12:5165 status=connecting http=200 reason="BreakTime is starting"`

### Connection Failure

The module retries every 5 seconds by itself. The status message always shows the latest reason, but the log is quieter: one `conn: lost` line when the problem starts, nothing more while the retries keep failing, and one line when it clears. A different condition in between (for example `conn: starting` while BreakTime restarts) is logged, and a later loss is then logged again.

A connection that was working and dropped, for example while BreakTime was stopped for about 15 seconds. During the outage the status message changed to "Cannot reach BreakTime (ECONNREFUSED)" without a new log line:

```
conn: lost host=10.1.4.12:5165 status=connection_failure reason="Connection to BreakTime closed (code 1006)"
conn: restored host=10.1.4.12:5165 status=ok attempts=3 down=15s version=2.0.222-beta+e8d7026389 security=off role=Primary acting=true
```

A connection that never worked logs the first failure, then `conn: connected` (not `restored`) once BreakTime answers:

```
conn: lost host=10.1.4.12:5165 status=connection_failure reason="Cannot reach BreakTime (ECONNREFUSED)"
conn: connected host=10.1.4.12:5165 status=ok version=2.0.222-beta+e8d7026389 security=off role=Primary acting=true
```

The reasons:

- "Connection to BreakTime closed (code 1006)": a working connection closed, for example BreakTime stopped or restarted, or the network dropped. This is the usual first line of an outage. Another close code can appear in its place.
- "No update from BreakTime for 5s": the connection stayed open but BreakTime stopped sending updates (about one per second), so the module dropped it and reconnects. A known cause is Zixi output with a slow or unreachable Zixi Broadcaster: a Count Down event ending on its own can hold BreakTime's timer for about 6 seconds.
  `conn: lost host=10.1.4.12:5165 status=connection_failure reason="No update from BreakTime for 5s"`
- "BreakTime needs a valid API key, reconnecting": an action got HTTP 401 because BreakTime security is on and the key is missing, wrong or revoked. The module drops the connection; the next attempt reports Authentication Failure.
  `conn: lost host=10.1.4.12:5165 status=connection_failure reason="BreakTime needs a valid API key, reconnecting"`
  `conn: auth failed host=10.1.4.12:5165 status=authentication_failure http=401 reason="BreakTime rejected the API key"`
- "Cannot reach BreakTime (ECONNREFUSED)": the module could not open a connection to BreakTime at all: BreakTime is not running, or the host, port, firewall or network is wrong. Another error code (for example `ENOTFOUND` for a hostname that does not resolve) can appear in its place.
- "BreakTime did not respond": the version check got no answer within 4 seconds.
  `conn: lost host=10.1.4.12:5165 status=connection_failure reason="BreakTime did not respond"`
- "Unexpected response from BreakTime (HTTP 503)" (or another HTTP status): the version check or the connection request got an unexpected HTTP answer; the line carries `http=`.
  `conn: lost host=10.1.4.12:5165 status=connection_failure http=503 reason="Unexpected response from BreakTime (HTTP 503)"`
- "Connection to BreakTime timed out": the connection request got no answer within 5 seconds.
  `conn: lost host=10.1.4.12:5165 status=connection_failure reason="Connection to BreakTime timed out"`
- Rarely "Connection error: ...", "Could not send to BreakTime: ..." or "Connection attempt failed: ...": an unexpected error; the text after the colon is the system's message.

### OK, but an action does nothing

Look for the `action:` line and the warning:

- `outcome=NotSent`: a local check refused it and nothing was sent; `reason=` says why.
  `action: start event="Event 3" id=9b2d4e61-3c7a-4f18-8e05-1a6c2d9f7b34 outcome=NotSent reason="Event is already running"`
- `reason="Pressed again within 0.5 s"`: a Start or End pressed again within half a second of one that was sent. It is ignored on purpose; see Pressing Start or End twice.
  `action: end target=latest outcome=NotSent reason="Pressed again within 0.5 s"`
- An outcome from BreakTime other than `Accepted`, for example `NotLicensed`, `UnpairedSecondary`, `EventNotFound`, `AlreadyInThatState` or `NothingArmed`: BreakTime refused it; `detail=` is BreakTime's explanation. An End that finds the event already ended (`AlreadyInThatState`) and a duplicate request (`DuplicateActuation`) are logged without a warning.
- "Nothing sent from this instance: ...": BreakTime accepted the start or end but sent nothing from this instance; the text after the colon is BreakTime's reason.
- "This BreakTime version does not support this action": the BreakTime build is too old for this module (an early 2.0 build).
- "API key lacks permission for this action": the key's role in BreakTime does not allow this action.
- **"Not confirmed by BreakTime, it may have gone through. Check what is running before pressing again."** after a start or end: BreakTime did not answer within 4 seconds (`outcome=Timeout`) or failed while handling it (`outcome=Unknown http=500`). **It may well have gone through.** Check what is running (the BreakTime UI, `running_events_count` or Event is Running) before pressing again. A known cause is Zixi output enabled with a slow or unreachable Zixi Broadcaster: BreakTime waits up to 5 seconds on it during every start and end. After an unconfirmed arm the warning reads "Not confirmed by BreakTime, the arm may have changed". The module never retries these by itself.
  `action: start event="Event 2" id=6f1c2a7e-0b3d-4c55-9a1e-2f7d8c9b0e41 outcome=Timeout took=4s`
- A duration change refused by BreakTime with HTTP 409: the event is running.
  `action: duration event="Event 2" id=6f1c2a7e-0b3d-4c55-9a1e-2f7d8c9b0e41 delta=-5 outcome=HttpError http=409 detail="Cannot adjust this event's duration while \"Event 2\" is running. End the event first." took=9ms`

## Reading the log

Every module line has the form `<area>: <verb> key=value key=value ...`. Companion adds the time, connection label and level.

| Area     | Verbs                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------ |
| `config` | `applied` (the first line, and after a change to any setting except Show Advanced Settings), `invalid` |
| `conn`   | `connected`, `restored`, `lost`, `auth failed`, `unsupported`, `starting`                              |
| `action` | `start`, `start armed`, `end`, `arm`, `arm next`, `arm previous`, `duration`                           |
| `state`  | `component changed`, `ha changed`, `global warning`, `frame error`, `playlist changed`, `frame dump`   |
| `rest`   | `request` (Verbose Logging only), `failed`                                                             |

- Lines are written on changes only: a condition is logged when it starts and when it clears, never once per retry.
- Every button press writes exactly one `action:` line; End with target All writes one per event. Each has an `outcome=`: BreakTime's answer (`Accepted`, `NotLicensed`, `UnpairedSecondary`, `RecoveringState`, `EventNotFound`, `AlreadyInThatState`, `PlaylistReplaced`, `DuplicateActuation`, `NothingArmed`), or `NotSent` (with `reason=`), `HttpError` (with `http=`), `Timeout`, `NetworkError` or `Unknown`. Accepted lines are info, everything else warn.
- `reason=` is the module's own text; `detail=` is BreakTime's text. On an accepted start or end, `detail=` shows where the message was sent, for example `"sent to Stream Injector"`; `"sent to X; <refusal>"` means one output refused.
- `acting=false` marks an arm or duration press sent to an HA standby instance. Start, Start Armed and End lines never carry `acting=`, so its absence on those lines says nothing about which instance they reached.
- **Matching BreakTime's history:** accepted `start`, `start armed` and `end` lines carry `firingId=` and `seq=`. Search BreakTime's event history for that firing ID. Arm and duration lines never carry them.
  `action: start event="Event 2" id=6f1c2a7e-0b3d-4c55-9a1e-2f7d8c9b0e41 outcome=Accepted firingId=0c9e7b52-61f4-4a2d-8f3b-9d1e5a6c7b80 seq=42 detail="sent to Stream Injector" took=18ms`
- Rapid arm presses that were combined each log their own line naming their own target (`event=`, `id=`), with the outcome of the request they were combined into. When that request armed a different event, the line adds `to=` with that event's ID and has no `detail=`: the outcome belongs to the `to=` event, and the press's own event was never sent to BreakTime. For example, the second of three quick Arm Next presses from Event 1, combined into the request that armed Event 4:
  `action: arm next event="Event 3" id=3c7d9e1f-2a4b-4c6d-8e0f-1a2b3c4d5e6f to=5e9f1b3d-4c6e-4a8b-9d0f-2b3c4d5e6f70 outcome=Accepted took=41ms`
- Arm and run changes seen in BreakTime's state are not logged: BreakTime's own history records them.
- `state: frame dump` lines (the raw state) appear only when Verbose Logging and Log Raw BreakTime Data (both under Show Advanced Settings) are on. API keys are never logged.
