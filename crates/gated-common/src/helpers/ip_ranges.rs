//! Address ranges a user is limited to.

use std::net::IpAddr;

use ipnet::IpNet;

/// Parses `"10.0.0.0/8"` or a single address such as `"192.168.1.7"`.
fn parse_range(range: &str) -> Option<IpNet> {
    let range = range.trim();
    range
        .parse::<IpNet>()
        .ok()
        .or_else(|| range.parse::<IpAddr>().ok().map(IpNet::from))
}

/// Trims every entry and names the first one that is not an address or a
/// CIDR range.
pub fn normalize_ip_ranges(ranges: &[String]) -> Result<Vec<String>, String> {
    ranges
        .iter()
        .map(|range| match parse_range(range) {
            Some(_) => Ok(range.trim().to_owned()),
            None => Err(format!("{range:?} is not an IP address or a CIDR range")),
        })
        .collect()
}

/// Whether `ip` may be used by someone limited to `ranges`. No list or an
/// empty one is no limit. With a limit, an unknown address is refused, and
/// so is every address when no entry parses.
pub fn ip_allowed(ranges: Option<&[String]>, ip: Option<IpAddr>) -> bool {
    let Some(ranges) = ranges.filter(|ranges| !ranges.is_empty()) else {
        return true;
    };
    let Some(ip) = ip.map(|ip| ip.to_canonical()) else {
        return false;
    };
    ranges
        .iter()
        .filter_map(|range| parse_range(range))
        .any(|range| range.contains(&ip))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ranges(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    fn ip(s: &str) -> Option<IpAddr> {
        s.parse().ok()
    }

    #[test]
    fn no_list_or_an_empty_list_is_no_limit() {
        assert!(ip_allowed(None, ip("203.0.113.9")));
        assert!(ip_allowed(None, None));
        assert!(ip_allowed(Some(&[]), ip("203.0.113.9")));
    }

    #[test]
    fn an_address_must_be_inside_one_of_the_ranges() {
        let list = ranges(&["10.0.0.0/8", "192.168.1.7", "2001:db8::/32"]);
        let list = Some(list.as_slice());
        assert!(ip_allowed(list, ip("10.20.30.40")));
        assert!(ip_allowed(list, ip("192.168.1.7")));
        assert!(ip_allowed(list, ip("2001:db8::1")));
        assert!(ip_allowed(list, ip("::ffff:10.1.2.3")));
        assert!(!ip_allowed(list, ip("192.168.1.8")));
        assert!(!ip_allowed(list, ip("11.0.0.1")));
        assert!(!ip_allowed(list, ip("2001:db9::1")));
    }

    #[test]
    fn with_a_limit_an_unknown_address_is_refused() {
        let list = ranges(&["10.0.0.0/8"]);
        assert!(!ip_allowed(Some(&list), None));
        let unusable = ranges(&["garbage"]);
        assert!(!ip_allowed(Some(&unusable), ip("10.0.0.1")));
    }

    #[test]
    fn entries_are_trimmed_and_malformed_ones_are_named() {
        assert_eq!(
            normalize_ip_ranges(&ranges(&[" 10.0.0.0/8 ", "::1"])),
            Ok(ranges(&["10.0.0.0/8", "::1"]))
        );
        for bad in ["10.0.0.0/33", "not-an-address", "10.0.0.1/", ""] {
            assert!(normalize_ip_ranges(&ranges(&[bad])).is_err(), "{bad:?}");
        }
    }
}
