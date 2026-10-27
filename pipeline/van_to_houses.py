"""Turn the geocoded VAN export into the cutter's door list.

One row per DOOR (address including unit). People at the same door are one knock.
Columns match what turfcut.py / canvass.py expect:
  van_id (door id), building_id (address without unit), unit_no, units,
  lat, lon, street, address, n_voters, voters (name list), van_ids (voter ids)
"""
import re, usaddress, pandas as pd

UNIT_TAGS = {"OccupancyType", "OccupancyIdentifier", "SubaddressType", "SubaddressIdentifier"}
STREET_TAGS = ["StreetNamePreDirectional", "StreetNamePreType", "StreetName", "StreetNamePostType", "StreetNamePostDirectional"]

def parse(addr):
    try:
        tags = usaddress.tag(addr)[0]
    except usaddress.RepeatedLabelError:
        tags = dict(usaddress.parse(addr))
        tags = {v: k for k, v in tags.items()}
    street = " ".join(tags[t] for t in STREET_TAGS if t in tags)
    unit = " ".join(v for k, v in tags.items() if k in UNIT_TAGS)
    number = tags.get("AddressNumber", "")
    if not unit:   # usaddress misses some designators (Spc, Space, Slip, ...)
        m = re.search(r"\b(Spc|Space|Slip|Lot|Trlr|Apt|Unit|Ste|Bldg|Rm|Fl|Ofc|Pmb)\.?\s*#?\s*(\S+)$|(#)\s*(\S+)$", addr, re.I)
        if m:
            unit = m.group(0).strip()
            if street.upper().endswith(m.group(0).strip().upper()):
                street = street[:-len(m.group(0).strip())].strip()
    return number, street, unit

df = pd.read_csv("data/van_doors.csv", dtype=str)
df["Address"] = df.Address.fillna("").str.strip()
parsed = df.Address.map(parse)
df["house_no"], df["street"], df["unit"] = zip(*parsed)
df["building_key"] = (df.house_no + " " + df.street).str.upper().str.strip() + "|" + df.Zip5.fillna("")
df["door_key"] = df.building_key + "|" + df.unit.str.upper()
df["name"] = (df.FirstName.fillna("") + " " + df.LastName.fillna("")).str.strip()

geo_ok = df.match.eq("Match")
print(f"{len(df)} voters; geocoded {geo_ok.sum()} ({geo_ok.mean():.1%}); exact {df.matchtype.eq('Exact').sum()}")
print("unparsed street:", (df.street == "").sum())

doors = (df[geo_ok].groupby("door_key").agg(
    building_key=("building_key", "first"), unit=("unit", "first"), address=("Address", "first"),
    city=("City", "first"), zip=("Zip5", "first"), street=("street", "first"), lat=("lat", "first"), lon=("lon", "first"),
    n_voters=("name", "size"), voters=("name", lambda s: "; ".join(s)), van_ids=("Voter File VANID", lambda s: ";".join(s)),
    hd=("HD", "first")).reset_index())
doors["building_id"] = doors.building_key.astype("category").cat.codes + 1
doors["van_id"] = range(1, len(doors) + 1)                       # door id used by the cutter
doors["unit_no"] = doors.groupby("building_id").cumcount() + 1
doors["units"] = doors.groupby("building_id")["van_id"].transform("size")
doors["lat"] = doors.lat.astype(float); doors["lon"] = doors.lon.astype(float)
doors.to_csv("data/houses_van.csv", index=False)
print(f"{len(doors)} doors at {doors.building_id.nunique()} buildings; multi-unit buildings: {(doors.units > 1).groupby(doors.building_id).first().sum()}")
print(doors.units.describe().round(1).to_string())
unm = df[~geo_ok]
unm[["Voter File VANID", "Address", "City", "Zip5", "HD", "match"]].to_csv("data/ungeocoded.csv", index=False)
print(f"wrote data/houses_van.csv; {len(unm)} ungeocoded voters -> data/ungeocoded.csv")
print(unm.City.value_counts().head(10).to_string())
