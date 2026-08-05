use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub state: String, // "idle"|"connecting"|"playing"|"rotating"|"closed"
    pub started_at_ms: Option<f64>,
    pub duration_cap_ms: f64,
    pub rotate_at_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MusicConfig {
    pub bpm: f64,
    pub scale: String,
    pub guidance: f64,
    pub density: f64,
    pub brightness: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WeightedPrompt {
    pub text: String,
    pub weight: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HubState {
    pub session: Session,
    pub music: MusicConfig,
    pub prompts: Vec<WeightedPrompt>,
    pub control_params: BTreeMap<String, f64>,
}

impl Default for HubState {
    fn default() -> Self {
        HubState {
            session: Session {
                id: "none".into(),
                state: "idle".into(),
                started_at_ms: None,
                duration_cap_ms: 600_000.0,
                rotate_at_ms: None,
            },
            music: MusicConfig {
                bpm: 120.0,
                scale: "C_MAJOR".into(),
                guidance: 3.0,
                density: 0.5,
                brightness: 0.5,
            },
            prompts: Vec::new(),
            control_params: BTreeMap::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_idle_with_cap() {
        let s = HubState::default();
        assert_eq!(s.session.state, "idle");
        assert_eq!(s.session.duration_cap_ms, 600_000.0);
        assert!(s.session.started_at_ms.is_none());
    }

    #[test]
    fn serializes_to_camelcase() {
        let s = HubState::default();
        let v = serde_json::to_value(&s).unwrap();
        assert!(v["session"]["durationCapMs"].is_number());
        assert!(v["session"]["startedAtMs"].is_null());
        assert!(v["music"]["brightness"].is_number());
        assert!(v["controlParams"].is_object());
    }

    #[test]
    fn roundtrips_through_json() {
        let mut s = HubState::default();
        s.session.state = "playing".into();
        s.prompts.push(WeightedPrompt {
            text: "warm pads".into(),
            weight: 0.8,
        });
        let json = serde_json::to_string(&s).unwrap();
        let back: HubState = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }
}
