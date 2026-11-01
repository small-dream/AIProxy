use rusqlite::{Row, RowIndex};

/// Read a non-negative integer column into `u32` without failing the whole
/// query on an out-of-range legacy value.
///
/// Older versions wrote `u32` values (a priority above `i32::MAX`, a negative
/// sort order produced by user input) but read them back through `i32`. One
/// out-of-range row therefore aborted the entire category's `load_all_*` call,
/// and the startup loader's `if let Ok(rows)` silently dropped every rule of
/// that kind (P1-9). Clamping keeps the rest of the table usable and normalizes
/// the value to the `u32` wire model (`i32::MIN as u32` used to become ~4.29e9,
/// which could delay a request for weeks).
pub(crate) fn read_u32<I: RowIndex>(row: &Row<'_>, index: I) -> rusqlite::Result<u32> {
    let value: i64 = row.get(index)?;
    Ok(value.clamp(0, i64::from(u32::MAX)) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_out_of_range_values() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE numbers (value INTEGER);
                 INSERT INTO numbers VALUES (-10), (0), (42), (2147483648), (4294967295), (4294967296);",
            )
            .unwrap();
        let mut statement = connection
            .prepare("SELECT value FROM numbers ORDER BY rowid")
            .unwrap();
        let values: Vec<u32> = statement
            .query_map([], |row| read_u32(row, 0))
            .unwrap()
            .map(|value| value.unwrap())
            .collect();
        assert_eq!(
            values,
            vec![0, 0, 42, 2_147_483_648, 4_294_967_295, 4_294_967_295]
        );
    }
}
