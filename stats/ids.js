// Reading ids the Honda e app renamed or dropped (its honda-e.json "renamed" table), so a GPX written before
// keeps reading: old id -> new id, null = dropped (a single byte of a wider signal, meaningless on its own).
// A plain script on purpose: index.html loads it with <script src>, stats/gpx.js imports it for the worker.
(function (g) {
  const RENAMED = {
    aircon: "radiator_fan_duty",
    cabin_temp_cand: "cabin_temp",
    charge_limit_cand: "cell_voltage_limit",
    charge_target_cand: "charge_voltage_target",
    current_alt: "inverter_current",
    dcfc_cand: null,
    motor_rpm: "vehicle_speed_fine",
    outside_temp_cand: "outside_air_temp",
    pack_cold_cand: "bms_supply_mode_request",
    pack_voltage_alt: "charger_output_voltage",
    pack_voltage_b_cand: "vcu_input_voltage",
    temp_a: "charger_temp_1",
    temp_a2: "charger_temp_2",
    temp_b: "ac_inlet_temp_1",
    temp_b2: "ac_inlet_temp_2",
    temp_c: "dc_inlet_temp_1",
    temp_c2: "dc_inlet_temp_2",
    temp_d: "module_temp_max",
    temp_d2: "module_temp_min",
    thermal_state: null,
  };

  /** [log] (parseGpx's shape) with its columns and field key under today's ids. */
  function migrateIds(log) {
    const to = id => (id in RENAMED ? RENAMED[id] : id);
    const cols = {}, key = {};
    for (const id in log.cols) { const n = to(id); if (n && !(n in cols)) cols[n] = log.cols[id]; }
    for (const id in log.key) { const n = to(id); if (n && !(n in key)) key[n] = log.key[id]; }
    return { ...log, cols, key };
  }

  g.HondaIds = { RENAMED, migrateIds };
})(globalThis);
