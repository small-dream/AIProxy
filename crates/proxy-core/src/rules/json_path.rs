use super::types::RewriteBodyFieldPayload;

#[derive(Debug)]
pub(crate) enum JsonPathSegment {
    Index(usize),
    Key(String),
}

pub(crate) fn parse_json_field_path(path: &str) -> Result<Vec<JsonPathSegment>, String> {
    let mut normalized = path.trim();
    if normalized == "$" {
        return Err("body field path must point to a JSON field".to_string());
    }
    if let Some(stripped) = normalized.strip_prefix("$.") {
        normalized = stripped;
    } else if let Some(stripped) = normalized.strip_prefix('$') {
        normalized = stripped.strip_prefix('.').unwrap_or(stripped);
    }

    if normalized.is_empty() {
        return Err("body field path is empty".to_string());
    }

    let chars: Vec<char> = normalized.chars().collect();
    let mut segments = Vec::new();
    let mut key = String::new();
    let mut index = 0;

    while index < chars.len() {
        match chars[index] {
            '.' => {
                if key.is_empty() {
                    if segments.is_empty() || index + 1 >= chars.len() || chars[index + 1] == '.' {
                        return Err(format!(
                            "body field path '{path}' contains an empty segment"
                        ));
                    }
                    index += 1;
                    continue;
                }
                segments.push(JsonPathSegment::Key(std::mem::take(&mut key)));
                index += 1;
            }
            '[' => {
                if !key.is_empty() {
                    segments.push(JsonPathSegment::Key(std::mem::take(&mut key)));
                }
                index += 1;
                let start = index;
                while index < chars.len() && chars[index] != ']' {
                    index += 1;
                }
                if index >= chars.len() || start == index {
                    return Err(format!(
                        "body field path '{path}' contains an invalid array index"
                    ));
                }
                let raw_index: String = chars[start..index].iter().collect();
                let array_index = raw_index.parse::<usize>().map_err(|_| {
                    format!("body field path '{path}' contains a non-numeric array index")
                })?;
                segments.push(JsonPathSegment::Index(array_index));
                index += 1;
            }
            ']' => {
                return Err(format!(
                    "body field path '{path}' contains an unmatched ']'"
                ))
            }
            c => {
                key.push(c);
                index += 1;
            }
        }
    }

    if !key.is_empty() {
        segments.push(JsonPathSegment::Key(key));
    }
    if segments.is_empty() {
        return Err("body field path is empty".to_string());
    }

    Ok(segments)
}

pub(crate) fn json_value_preview(value: &serde_json::Value) -> Option<String> {
    serde_json::to_string(value).ok()
}

pub(crate) fn get_json_path_value<'a>(
    root: &'a serde_json::Value,
    segments: &[JsonPathSegment],
) -> Option<&'a serde_json::Value> {
    let mut current = root;
    for segment in segments {
        match segment {
            JsonPathSegment::Key(key) => current = current.as_object()?.get(key)?,
            JsonPathSegment::Index(index) => current = current.as_array()?.get(*index)?,
        }
    }
    Some(current)
}

pub(crate) fn coerce_body_field_value(field: &RewriteBodyFieldPayload) -> Result<serde_json::Value, String> {
    let raw_value = field.value.as_deref().unwrap_or_default();
    match field
        .value_type
        .as_deref()
        .unwrap_or("string")
        .to_ascii_lowercase()
        .as_str()
    {
        "boolean" => raw_value
            .parse::<bool>()
            .map(serde_json::Value::Bool)
            .map_err(|_| format!("body field '{}' requires a boolean value", field.path)),
        "json" => serde_json::from_str(raw_value)
            .map_err(|error| format!("body field '{}' contains invalid JSON: {error}", field.path)),
        "null" => Ok(serde_json::Value::Null),
        "number" => {
            let number = raw_value
                .parse::<f64>()
                .map_err(|_| format!("body field '{}' requires a numeric value", field.path))?;
            serde_json::Number::from_f64(number)
                .map(serde_json::Value::Number)
                .ok_or_else(|| {
                    format!(
                        "body field '{}' requires a finite numeric value",
                        field.path
                    )
                })
        }
        "string" => Ok(serde_json::Value::String(raw_value.to_string())),
        other => Err(format!(
            "body field '{}' uses unsupported value type '{other}'",
            field.path
        )),
    }
}

pub(crate) fn set_json_path_value(
    root: &mut serde_json::Value,
    segments: &[JsonPathSegment],
    value: serde_json::Value,
) -> Result<(), String> {
    let Some((last, parents)) = segments.split_last() else {
        return Err("body field path is empty".to_string());
    };
    let mut current = root;

    for segment in parents {
        match segment {
            JsonPathSegment::Key(key) => {
                if !current.is_object() {
                    *current = serde_json::Value::Object(serde_json::Map::new());
                }
                let object = current
                    .as_object_mut()
                    .expect("object was just initialized");
                current = object
                    .entry(key.clone())
                    .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            }
            JsonPathSegment::Index(index) => {
                let array = current
                    .as_array_mut()
                    .ok_or_else(|| format!("body field path expects an array at index {index}"))?;
                current = array.get_mut(*index).ok_or_else(|| {
                    format!("body field path array index {index} is out of range")
                })?;
            }
        }
    }

    match last {
        JsonPathSegment::Key(key) => {
            if !current.is_object() {
                *current = serde_json::Value::Object(serde_json::Map::new());
            }
            let object = current
                .as_object_mut()
                .expect("object was just initialized");
            object.insert(key.clone(), value);
            Ok(())
        }
        JsonPathSegment::Index(index) => {
            let array = current
                .as_array_mut()
                .ok_or_else(|| format!("body field path expects an array at index {index}"))?;
            if *index == array.len() {
                array.push(value);
                Ok(())
            } else {
                let slot = array.get_mut(*index).ok_or_else(|| {
                    format!("body field path array index {index} is out of range")
                })?;
                *slot = value;
                Ok(())
            }
        }
    }
}

pub(crate) fn remove_json_path_value(
    root: &mut serde_json::Value,
    segments: &[JsonPathSegment],
) -> Result<(), String> {
    let Some((last, parents)) = segments.split_last() else {
        return Err("body field path is empty".to_string());
    };
    let mut current = root;

    for segment in parents {
        match segment {
            JsonPathSegment::Key(key) => {
                current = current
                    .as_object_mut()
                    .and_then(|object| object.get_mut(key))
                    .ok_or_else(|| format!("body field path parent '{key}' does not exist"))?;
            }
            JsonPathSegment::Index(index) => {
                current = current
                    .as_array_mut()
                    .and_then(|array| array.get_mut(*index))
                    .ok_or_else(|| {
                        format!("body field path array index {index} is out of range")
                    })?;
            }
        }
    }

    match last {
        JsonPathSegment::Key(key) => {
            current
                .as_object_mut()
                .ok_or_else(|| format!("body field path parent for '{key}' is not an object"))?
                .remove(key);
            Ok(())
        }
        JsonPathSegment::Index(index) => {
            let array = current.as_array_mut().ok_or_else(|| {
                format!("body field path parent for index {index} is not an array")
            })?;
            if *index < array.len() {
                array.remove(*index);
                Ok(())
            } else {
                Err(format!(
                    "body field path array index {index} is out of range"
                ))
            }
        }
    }
}
