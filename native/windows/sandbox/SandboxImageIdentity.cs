// SPDX-FileCopyrightText: 2026 Nerva contributors
// SPDX-License-Identifier: LicenseRef-Proprietary

using System;
using System.Text.RegularExpressions;

/// <summary>Immutable physical native name and volume/128-bit file identity; never treats DOS aliases or case folding as identity.</summary>
internal sealed class SandboxImageIdentity
{
    internal readonly string NativeName;
    private readonly byte[] identifier;

    internal SandboxImageIdentity(string nativeName, byte[] fileIdInformation)
    {
        if (nativeName == null || nativeName.Length > 4095 || fileIdInformation == null || fileIdInformation.Length != 24) throw new ArgumentException("invalid image identity");
        Match prefix = Regex.Match(nativeName, @"\A\\Device\\HarddiskVolume[0-9]+\\", RegexOptions.CultureInvariant);
        if (!prefix.Success || prefix.Length == nativeName.Length) throw new ArgumentException("invalid image identity");
        try
        {
            foreach (string name in nativeName.Substring(prefix.Length).Split(new char[] { '\\' })) NexaConnectorStateOwner.ValidateLeaf(name);
        }
        catch { throw new ArgumentException("invalid image identity"); }
        NativeName = nativeName;
        identifier = (byte[])fileIdInformation.Clone();
    }

    internal bool MatchesName(string nativeName)
    {
        return String.Equals(NativeName, nativeName, StringComparison.Ordinal);
    }

    internal bool Matches(SandboxImageIdentity other)
    {
        if (other == null || !MatchesName(other.NativeName)) return false;
        for (int i = 0; i < identifier.Length; i++) if (identifier[i] != other.identifier[i]) return false;
        return true;
    }
}
